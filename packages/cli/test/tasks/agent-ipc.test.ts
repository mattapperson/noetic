/**
 * End-to-end integration test for the agent IPC server + client.
 *
 * Spins up a real `AgentIpcServer` bound to a temp unix-domain socket
 * and a real `AgentIpcClient` that connects over the wire. The harness
 * is a structural stub satisfying `IpcHarness` — the minimal interface
 * the server uses — so we don't need any casts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessStatus, Item, StreamEvent, StreamingItem } from '@noetic/core';
import { createLocalFsAdapter } from '@noetic/core';

import { AgentIpcClient } from '../../src/commands/builtins/tasks/agent-ipc-client.js';
import type { IpcHarness } from '../../src/commands/builtins/tasks/agent-ipc-server.js';
import { AgentIpcServer } from '../../src/commands/builtins/tasks/agent-ipc-server.js';
import { appendChatItem } from '../../src/commands/builtins/tasks/chat-history-store.js';
import { createIpcAskUserService } from '../../src/commands/builtins/tasks/ipc-ask-user-service.js';

const TASK_ID = 'T-ipc000001';
const ROLE = 'planner';
const RUNNER_ID = 'planner';
const THREAD_ID = 'thread-1';

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

interface ExecuteCall {
  readonly input: string;
  readonly threadId: string | undefined;
  readonly messageId: string | undefined;
}

interface StubHarness extends IpcHarness {
  readonly executes: ReadonlyArray<ExecuteCall>;
  pushItem(item: StreamingItem): void;
  pushEvent(event: StreamEvent): void;
  setStatus(status: HarnessStatus): void;
  closeStreams(): void;
}

function makeStubHarness(): StubHarness {
  const itemQueue = makeQueueIterable<StreamingItem>();
  const eventQueue = makeQueueIterable<StreamEvent>();
  const executes: ExecuteCall[] = [];
  let status: HarnessStatus = {
    kind: 'idle',
  };
  return {
    executes,
    execute(input, options) {
      executes.push({
        input,
        threadId: options?.threadId,
        messageId: options?.messageId,
      });
      return Promise.resolve();
    },
    getItemStream() {
      return itemQueue.iter;
    },
    getFullStream() {
      return eventQueue.iter;
    },
    getStatus() {
      return status;
    },
    abort() {
      return Promise.resolve();
    },
    pushItem(item) {
      itemQueue.push(item);
    },
    pushEvent(event) {
      eventQueue.push(event);
    },
    setStatus(next) {
      status = next;
    },
    closeStreams() {
      itemQueue.close();
      eventQueue.close();
    },
  };
}

describe('agent-ipc end-to-end', () => {
  let projectRoot: string;
  let server: AgentIpcServer | null;
  let client: AgentIpcClient | null;
  let harness: StubHarness | null;

  beforeEach(async () => {
    // Unix-domain socket paths max out at ~104 bytes on macOS, so the
    // default tmpdir (/var/folders/...) is too long. Use /tmp directly
    // to keep the full path under the limit.
    projectRoot = await mkdtemp(join('/tmp', 'n-ipc-'));
    server = null;
    client = null;
    harness = null;
  });

  afterEach(async () => {
    // Order matters: close harness streams first so the server's pump
    // loops exit, then close the server (which waits for the pumps and
    // sends `bye` to any remaining clients), then close the client.
    harness?.closeStreams();
    await server?.close('test-teardown');
    client?.close();
    await rm(projectRoot, {
      recursive: true,
      force: true,
    });
  });

  it('round-trips connect → history → send → ack with streamed items', async () => {
    const ctx = {
      fs: createLocalFsAdapter(),
      projectRoot,
    };

    const userMessage = (id: string, text: string): Item => ({
      id,
      type: 'message',
      role: 'user',
      status: 'completed',
      content: [
        {
          type: 'input_text',
          text,
        },
      ],
    });

    // Seed prior chat history on disk so we can verify history replay.
    await appendChatItem(ctx, TASK_ID, userMessage('m-prior', 'hello from yesterday'));

    harness = makeStubHarness();
    server = new AgentIpcServer({
      harness,
      storeCtx: ctx,
      taskId: TASK_ID,
      role: ROLE,
      runnerId: RUNNER_ID,
      threadId: THREAD_ID,
      askUserService: createIpcAskUserService({
        broadcastRequest: () => {},
        broadcastCleared: () => {},
      }),
    });
    await server.listen();

    client = new AgentIpcClient({
      socketPath: server.getSocketPath(),
    });
    const hello = await client.connect();
    expect(hello.taskId).toBe(TASK_ID);
    expect(hello.role).toBe(ROLE);
    expect(hello.runnerId).toBe(RUNNER_ID);
    expect(hello.threadId).toBe(THREAD_ID);

    const history = await client.getHistory();
    expect(history.length).toBe(1);

    const status = await client.getStatus();
    expect(status).toEqual({
      kind: 'idle',
    });

    const { items, events } = client.subscribe();
    const itemReader = items[Symbol.asyncIterator]();
    const eventReader = events[Symbol.asyncIterator]();

    // The `subscribe` frame is fire-and-forget — round-trip a status
    // request to be sure the server has processed `subscribe` (and
    // marked this client subscribed) before we start pushing events.
    await client.getStatus();

    const pushedItem: StreamingItem = {
      id: 'm-new',
      type: 'message',
      role: 'user',
      status: 'completed',
      content: [
        {
          type: 'input_text',
          text: 'streamed',
        },
      ],
      isComplete: true,
    };
    harness.pushItem(pushedItem);
    const pushedEvent: StreamEvent = {
      source: 'framework',
      type: 'stub:turn_started',
      data: {
        turnId: 't-1',
      },
    };
    harness.pushEvent(pushedEvent);

    const itemMsg = await itemReader.next();
    expect(itemMsg.done).toBe(false);
    expect(itemMsg.value).toMatchObject({
      id: 'm-new',
      type: 'message',
      isComplete: true,
    });

    const eventMsg = await eventReader.next();
    expect(eventMsg.done).toBe(false);
    expect(eventMsg.value).toMatchObject({
      source: 'framework',
      type: 'stub:turn_started',
    });

    await client.send({
      messageId: 'msg-A',
      text: 'hello agent',
    });
    expect(harness.executes.length).toBe(1);
    expect(harness.executes[0]).toEqual({
      input: 'hello agent',
      threadId: THREAD_ID,
      messageId: 'msg-A',
    });
  });

  it('client refuses send() after the server has closed', async () => {
    const ctx = {
      fs: createLocalFsAdapter(),
      projectRoot,
    };
    harness = makeStubHarness();
    server = new AgentIpcServer({
      harness,
      storeCtx: ctx,
      taskId: TASK_ID,
      role: ROLE,
      runnerId: RUNNER_ID,
      threadId: THREAD_ID,
      askUserService: createIpcAskUserService({
        broadcastRequest: () => {},
        broadcastCleared: () => {},
      }),
    });
    await server.listen();

    client = new AgentIpcClient({
      socketPath: server.getSocketPath(),
    });
    await client.connect();

    harness.closeStreams();
    await server.close('test-close');
    server = null;

    // Wait a tick for the bye frame to propagate so the client closes too.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(() =>
      client?.send({
        messageId: 'msg-after-close',
        text: 'never delivered',
      }),
    ).toThrow(/closed/);
  });
});
