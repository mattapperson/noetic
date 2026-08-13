/**
 * IPC hardening (platform-node slice review P3/P4).
 *
 * P3: frames from one client execute strictly in arrival order — a batch of
 *     sends in a single TCP chunk must reach `harness.execute` in order (the
 *     old fire-and-forget dispatch let them interleave).
 * P4: a server `error` frame carrying a `messageId` rejects ONLY that send's
 *     ack waiter — other in-flight sends may have executed and must not be
 *     failed into a duplicate retry.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HarnessStatus, StreamEvent, StreamingItem } from '@noetic-tools/core';
import { AgentIpcClient } from '../src/agent-ipc-client';
import type {
  ChatHistoryStore,
  IpcAskUserService,
  IpcHarness,
  TaskLogger,
} from '../src/agent-ipc-server';
import { AgentIpcServer } from '../src/agent-ipc-server';
import { createLocalFsAdapter } from '../src/local-fs-adapter';

const noopChatStore: ChatHistoryStore = {
  async readChatHistory() {
    return [];
  },
  async appendChatItem() {},
};
const noopLogger: TaskLogger = async () => {};
const stubAskUser: IpcAskUserService = {
  peek: () => null,
  handleResolve: () => {},
  handleCancel: () => {},
  cancelAll: () => {},
};

/**
 * A stream that stays pending until `close()` is called, then ends. The
 * server's pumps must be able to finish or `server.close()` never settles
 * (same teardown contract the durable-resume tests follow).
 */
function closableStream<T>(): {
  iter: AsyncIterable<T>;
  close(): void;
} {
  let closed = false;
  let notify: (() => void) | null = null;
  return {
    iter: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          async next(): Promise<IteratorResult<T>> {
            if (!closed) {
              await new Promise<void>((resolve) => {
                notify = resolve;
              });
            }
            return {
              value: undefined,
              done: true,
            };
          },
        };
      },
    },
    close() {
      closed = true;
      notify?.();
    },
  };
}

/** Both stub harnesses below report idle; neither test drives status. */
const IDLE_STATUS: HarnessStatus = {
  kind: 'idle',
};

let dir: string;
let socketPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'noetic-ipc-ord-'));
  socketPath = path.join(dir, 's.sock');
});

afterEach(() => {
  rmSync(dir, {
    recursive: true,
    force: true,
  });
});

function makeServer(harness: IpcHarness): AgentIpcServer {
  return new AgentIpcServer({
    harness,
    chatHistoryStore: noopChatStore,
    logger: noopLogger,
    taskId: 'T-ord',
    role: 'planner',
    runnerId: 'r1',
    threadId: 'thread-1',
    socketPath,
    askUserService: stubAskUser,
    fs: createLocalFsAdapter(),
  });
}

describe('P3 — per-client frame ordering', () => {
  it('a burst of sends reaches harness.execute strictly in order', async () => {
    const executed: string[] = [];
    const items = closableStream<StreamingItem>();
    const events = closableStream<StreamEvent>();
    const harness: IpcHarness = {
      async execute(input: string) {
        // Async gap: the old fire-and-forget dispatch let a later frame's
        // handler overtake this await.
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
        executed.push(input);
      },
      getItemStream: () => items.iter,
      getFullStream: () => events.iter,
      getStatus: () => IDLE_STATUS,
      abort: async () => {},
    };
    const server = makeServer(harness);
    await server.listen();

    const client = new AgentIpcClient({
      socketPath,
    });
    await client.connect();

    const sends = Array.from(
      {
        length: 8,
      },
      (_, i) =>
        client.send({
          messageId: `m-${i}`,
          text: `msg-${i}`,
        }),
    );

    await Promise.all(sends);

    expect(executed).toEqual(
      Array.from(
        {
          length: 8,
        },
        (_, i) => `msg-${i}`,
      ),
    );
    items.close();
    events.close();
    await server.close('test-end');
    client.close();
  });
});

describe('P4 — correlated error frames', () => {
  it('a failing send rejects only its own ack; concurrent sends still resolve', async () => {
    const items = closableStream<StreamingItem>();
    const events = closableStream<StreamEvent>();
    const harness: IpcHarness = {
      async execute(input: string) {
        if (input === 'poison') {
          throw new Error('scripted execute failure');
        }
      },
      getItemStream: () => items.iter,
      getFullStream: () => events.iter,
      getStatus: () => IDLE_STATUS,
      abort: async () => {},
    };
    const server = makeServer(harness);
    await server.listen();
    const client = new AgentIpcClient({
      socketPath,
    });
    await client.connect();

    const good1 = client.send({
      messageId: 'good-1',
      text: 'fine',
    });
    const bad = client.send({
      messageId: 'bad-1',
      text: 'poison',
    });
    const good2 = client.send({
      messageId: 'good-2',
      text: 'also fine',
    });

    // The poisoned send rejects with the handler error…
    let thrown: unknown;
    try {
      await bad;
    } catch (e) {
      thrown = e;
    }
    expect(String(thrown)).toContain('scripted execute failure');
    // …while the unrelated sends resolve normally (the old blanket
    // rejection failed all three).
    await good1;
    await good2;
    expect(client.getLastError()).not.toBeNull();

    items.close();
    events.close();
    await server.close('test-end');
    client.close();
  });
});
