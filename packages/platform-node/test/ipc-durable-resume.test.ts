/**
 * End-to-end durable resume test.
 *
 * Spins up a real `AgentIpcServer` against an in-memory storage with
 * durability opted-in, drives stream frames through it, then drops
 * the client mid-stream and reconnects. Verifies the wire contract:
 * a resuming client that replays its last-seen watermark receives
 * exactly the frames it missed — zero duplicates, zero losses.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createInMemoryStorage,
  type HarnessStatus,
  type Item,
  type StreamEvent,
  type StreamingItem,
} from '@noetic/core';
import { AgentIpcClient } from '../src/agent-ipc-client';
import {
  AgentIpcServer,
  type ChatHistoryStore,
  type IpcAskUserService,
  type IpcHarness,
  type TaskLogger,
} from '../src/agent-ipc-server';
import { createLocalFsAdapter } from '../src/local-fs-adapter';

//#region Test helpers

interface QueueIterable<T> {
  readonly iter: AsyncIterable<T>;
  push(value: T): void;
  close(): void;
}

function makeQueueIterable<T>(): QueueIterable<T> {
  const queue: T[] = [];
  let closed = false;
  let resolveNext: (() => void) | null = null;
  const notify = (): void => {
    if (resolveNext === null) {
      return;
    }
    const fn = resolveNext;
    resolveNext = null;
    fn();
  };
  return {
    iter: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          async next(): Promise<IteratorResult<T>> {
            for (;;) {
              const head = queue.shift();
              if (head !== undefined) {
                return {
                  value: head,
                  done: false,
                };
              }
              if (closed) {
                return {
                  value: undefined,
                  done: true,
                };
              }
              await new Promise<void>((resolve) => {
                resolveNext = resolve;
              });
            }
          },
        };
      },
    },
    push(value) {
      queue.push(value);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
  };
}

interface StubHarness extends IpcHarness {
  pushItem(item: StreamingItem): void;
  pushEvent(event: StreamEvent): void;
  closeStreams(): void;
}

function makeStubHarness(): StubHarness {
  const items = makeQueueIterable<StreamingItem>();
  const events = makeQueueIterable<StreamEvent>();
  const status: HarnessStatus = {
    kind: 'idle',
  };
  return {
    execute() {
      return Promise.resolve();
    },
    getItemStream() {
      return items.iter;
    },
    getFullStream() {
      return events.iter;
    },
    getStatus() {
      return status;
    },
    abort() {
      return Promise.resolve();
    },
    pushItem(item) {
      items.push(item);
    },
    pushEvent(event) {
      events.push(event);
    },
    closeStreams() {
      items.close();
      events.close();
    },
  };
}

const noopChatStore: ChatHistoryStore = {
  async readChatHistory() {
    return [];
  },
  async appendChatItem() {
    // drop
  },
};

const noopLogger: TaskLogger = async () => {
  // drop
};

const stubAskUser: IpcAskUserService = {
  peek: () => null,
  handleResolve: () => {
    // noop
  },
  handleCancel: () => {
    // noop
  },
  cancelAll: () => {
    // noop
  },
};

function itemFrame(id: string): StreamingItem {
  const base: Item = {
    id,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text: `msg-${id}`,
      },
    ],
  };
  return {
    ...base,
    isComplete: true,
  };
}

async function drainN<T>(iter: AsyncIterable<T>, n: number, timeoutMs = 1000): Promise<T[]> {
  const it = iter[Symbol.asyncIterator]();
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const deadline = Promise.race([
      it.next(),
      new Promise<{
        value: undefined;
        done: true;
      }>((resolve) => {
        setTimeout(
          () =>
            resolve({
              value: undefined,
              done: true,
            }),
          timeoutMs,
        );
      }),
    ]);
    const result = await deadline;
    if (result.done) {
      break;
    }
    out.push(result.value);
  }
  return out;
}

/**
 * Ensure any queued client→server frame (subscribe / durableResume)
 * has been processed before returning. getStatus round-trips the wire
 * end-to-end — the server only replies after draining the frames that
 * were already sitting ahead of it in the client's outbound buffer.
 */
async function awaitClientProcessed(client: AgentIpcClient): Promise<void> {
  await client.getStatus();
}

//#endregion

describe('AgentIpcServer durable resume (end-to-end, zero-dup-zero-loss)', () => {
  let root: string;
  let socketPath: string;

  beforeEach(() => {
    // Unix-domain sockets max out near 104 bytes on macOS, so use /tmp
    // directly rather than the default tmpdir (which on macOS is under
    // /var/folders/... and blows the limit for longer task-id suffixes).
    root = mkdtempSync(path.join(tmpdir(), 'n-ipc-dur-'));
    socketPath = path.join(
      '/tmp',
      `n-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
    );
  });

  afterEach(() => {
    rmSync(root, {
      recursive: true,
      force: true,
    });
    try {
      rmSync(socketPath, {
        force: true,
      });
    } catch {
      // ignore — server close also unlinks
    }
  });

  it('replays every un-acked frame to a reconnecting client, with no duplicates', async () => {
    const storage = createInMemoryStorage();
    const harness = makeStubHarness();
    const server = new AgentIpcServer({
      harness,
      chatHistoryStore: noopChatStore,
      logger: noopLogger,
      taskId: 'T-durable1',
      role: 'planner',
      runnerId: 'planner',
      threadId: 'thread-1',
      socketPath,
      askUserService: stubAskUser,
      fs: createLocalFsAdapter(),
      storage,
    });
    await server.listen();

    // Client 1: receive items 1-3, ack through 2, then drop.
    const client1 = new AgentIpcClient({
      socketPath,
    });
    await client1.connect();
    client1.sendDurableResume();
    const { items: items1 } = client1.subscribe();
    await awaitClientProcessed(client1);
    harness.pushItem(itemFrame('i-1'));
    harness.pushItem(itemFrame('i-2'));
    harness.pushItem(itemFrame('i-3'));
    const round1 = await drainN(items1, 3);
    expect(round1.length).toBe(3);
    expect(client1.getHighestDeliveredDurableSeq()).toBe(3);

    // Ack only through seq=2; frame seq=3 is still un-acked on server.
    client1.acknowledgeDurableFrames(2);
    // Give the ack a tick to land before we simulate the crash.
    await new Promise((r) => setTimeout(r, 3e1));
    expect(await server.queueSize()).toBe(1);

    // Simulate a client crash — destroy the socket without clean close
    // so the server-side representation is torn down the same way a
    // crashed TUI would leave it.
    client1.close();
    // Let the server observe the close event before we push more frames.
    await new Promise((r) => setTimeout(r, 3e1));

    // While the client is gone, the server gets two more items. They
    // append to the durable queue (seqs 4, 5) with no live subscriber.
    harness.pushItem(itemFrame('i-4'));
    harness.pushItem(itemFrame('i-5'));
    await new Promise((r) => setTimeout(r, 3e1));
    // Unacked frames: 3, 4, 5.
    expect(await server.queueSize()).toBe(3);

    // Client 2: reconnect with ackedThrough=2 — expect exactly
    // frames 3, 4, 5 to arrive, each exactly once.
    const client2 = new AgentIpcClient({
      socketPath,
    });
    await client2.connect();
    client2.sendDurableResume(2);
    const { items: items2 } = client2.subscribe();
    await awaitClientProcessed(client2);
    const round2 = await drainN(items2, 3);
    expect(round2.length).toBe(3);
    // Content check — pull the inner ids back out of the streaming items.
    const deliveredIds = round2.map((item) => {
      if (typeof item !== 'object' || item === null) {
        return null;
      }
      if (!('id' in item)) {
        return null;
      }
      // 'id' in item narrows item to { id: unknown } — read without casting.
      return typeof item.id === 'string' ? item.id : null;
    });
    expect(deliveredIds).toEqual([
      'i-3',
      'i-4',
      'i-5',
    ]);
    expect(client2.getHighestDeliveredDurableSeq()).toBe(5);

    // Acking through 5 compacts the whole queue.
    client2.acknowledgeDurableFrames(5);
    await new Promise((r) => setTimeout(r, 3e1));
    expect(await server.queueSize()).toBe(0);

    // Teardown order: streams → server → client. The reverse order
    // leaves the server-side socket half-closed while server.close()
    // waits on it, hanging the test.
    harness.closeStreams();
    await server.close('test-end');
    client2.close();
  });

  it('a fresh client (ackedThrough=0) receives every un-acked frame once the server has persisted them', async () => {
    const storage = createInMemoryStorage();
    const harness = makeStubHarness();
    const server = new AgentIpcServer({
      harness,
      chatHistoryStore: noopChatStore,
      logger: noopLogger,
      taskId: 'T-durable2',
      role: 'planner',
      runnerId: 'planner',
      threadId: 'thread-1',
      socketPath,
      askUserService: stubAskUser,
      fs: createLocalFsAdapter(),
      storage,
    });
    await server.listen();

    // Server produces frames before any client is connected.
    harness.pushItem(itemFrame('i-1'));
    harness.pushItem(itemFrame('i-2'));
    await new Promise((r) => setTimeout(r, 3e1));
    expect(await server.queueSize()).toBe(2);

    // A fresh client connects and issues durableResume(0) — expects replay.
    const client = new AgentIpcClient({
      socketPath,
    });
    await client.connect();
    client.sendDurableResume();
    const { items } = client.subscribe();
    await awaitClientProcessed(client);
    const delivered = await drainN(items, 2);
    expect(delivered.length).toBe(2);
    expect(client.getHighestDeliveredDurableSeq()).toBe(2);

    harness.closeStreams();
    await server.close('test-end');
    client.close();
  });

  it('non-durable server (no storage opt) does not wrap outbound frames', async () => {
    const harness = makeStubHarness();
    const server = new AgentIpcServer({
      harness,
      chatHistoryStore: noopChatStore,
      logger: noopLogger,
      taskId: 'T-plain',
      role: 'planner',
      runnerId: 'planner',
      threadId: 'thread-1',
      socketPath,
      askUserService: stubAskUser,
      fs: createLocalFsAdapter(),
      // no storage — durability disabled
    });
    await server.listen();

    expect(server.getDurableQueue()).toBeNull();
    expect(await server.queueSize()).toBe(0);

    const client = new AgentIpcClient({
      socketPath,
    });
    await client.connect();
    const { items } = client.subscribe();
    await awaitClientProcessed(client);
    harness.pushItem(itemFrame('plain'));
    const [received] = await drainN(items, 1);
    expect(received).toBeDefined();
    // No durable wrapper was used; client's highest delivered durable
    // seq stays 0.
    expect(client.getHighestDeliveredDurableSeq()).toBe(0);

    harness.closeStreams();
    await server.close('test-end');
    client.close();
  });
});
