import type {
  ExecuteInput,
  ExecuteOptions,
  Item,
  SessionScope,
  StreamEvent,
  StreamingItem,
} from '@noetic-tools/types';
import type {
  ChatFetchResult,
  ChatMessageLike,
  ChatStreamChunk,
  ChatThreadLike,
} from '../src/chat-types';
import type { ChatHarness } from '../src/harness-contract';

export function sdkEvent(type: string, data: Record<string, unknown>): StreamEvent {
  return {
    source: 'sdk',
    type,
    data,
  };
}

export function fwEvent(
  name: string,
  data: Record<string, unknown>,
  agentName = 'agent',
): StreamEvent {
  return {
    source: 'framework',
    type: `${agentName}:${name}`,
    data,
  };
}

export function chatMessage(overrides: {
  id: string;
  text?: string;
  userName?: string;
  isMe?: boolean;
  dateSent?: Date;
  attachments?: ChatMessageLike['attachments'];
}): ChatMessageLike {
  return {
    id: overrides.id,
    threadId: 'thread-1',
    text: overrides.text ?? '',
    author: {
      userId: `id-${overrides.userName ?? 'user'}`,
      userName: overrides.userName ?? 'user',
      fullName: overrides.userName ?? 'User',
      isBot: overrides.isMe ?? false,
      isMe: overrides.isMe ?? false,
    },
    metadata: {
      dateSent: overrides.dateSent ?? new Date(0),
      edited: false,
    },
    attachments: overrides.attachments ?? [],
  };
}

export interface MockHarness extends ChatHarness {
  readonly executed: Array<{
    input: ExecuteInput;
    options: ExecuteOptions | undefined;
  }>;
  readonly seeded: Array<{
    threadId: string;
    items: ReadonlyArray<Item>;
  }>;
  readonly streamScopes: Array<SessionScope | undefined>;
  /** Emit an arbitrary event through the emulated broadcaster. */
  emit(event: StreamEvent): void;
}

/**
 * Harness stub that emulates the real session pipeline's two sharp edges:
 * `execute()` emits `turn_started` + body + `turn_completed` SYNCHRONOUSLY
 * (before the returned promise settles), and the broadcaster REPLAYS its
 * buffer to late subscribers but DISCARDS events entirely once a
 * previously-attached consumer set is empty — a mock that emits after
 * subscription would hide the very ordering bugs these semantics cause.
 */
export function mockHarness(script: {
  /** Events emitted inside each execute(), between the turn boundary events. */
  body?: StreamEvent[];
  /** Items served by `getItemStream` (already flagged with `isComplete`). */
  items?: StreamingItem[];
  agentName?: string;
  /** Set false to suppress automatic turn events (tests emit their own). */
  autoTurn?: boolean;
}): MockHarness {
  const executed: MockHarness['executed'] = [];
  const seeded: MockHarness['seeded'] = [];
  const streamScopes: MockHarness['streamScopes'] = [];
  const agentName = script.agentName ?? 'agent';

  const buffer: StreamEvent[] = [];
  const wakeups: Array<() => void> = [];
  let everAttached = false;
  let liveConsumers = 0;
  let turnCounter = 0;

  const emit = (event: StreamEvent): void => {
    if (everAttached && liveConsumers === 0) {
      return; // the real broadcaster's discard rule
    }
    buffer.push(event);
    for (const wake of wakeups.splice(0)) {
      wake();
    }
  };

  // Manual iterator, NOT an async generator: the real BroadcastIterator
  // registers its consumer eagerly in [Symbol.asyncIterator]() — a lazy
  // generator body would defer attachment to the first next() and mask the
  // attach-before-execute requirement this mock exists to enforce.
  function consume(): AsyncIterator<StreamEvent> {
    everAttached = true;
    liveConsumers++;
    let cursor = 0;
    let finished = false;
    const finish = (): void => {
      if (!finished) {
        finished = true;
        liveConsumers--;
      }
    };
    return {
      async next(): Promise<IteratorResult<StreamEvent>> {
        while (!finished) {
          if (cursor < buffer.length) {
            return {
              value: buffer[cursor++],
              done: false,
            };
          }
          await new Promise<void>((resolve) => {
            wakeups.push(resolve);
          });
        }
        return {
          value: undefined,
          done: true,
        };
      },
      return(): Promise<IteratorResult<StreamEvent>> {
        finish();
        return Promise.resolve({
          value: undefined,
          done: true,
        });
      },
    };
  }

  return {
    executed,
    seeded,
    streamScopes,
    emit,
    execute(input, options) {
      executed.push({
        input,
        options,
      });
      if (script.autoTurn !== false) {
        const turnId = `turn-${++turnCounter}`;
        const messageId = options?.messageId ?? 'unknown';
        emit(
          fwEvent(
            'turn_started',
            {
              turnId,
              messageIds: [
                messageId,
              ],
            },
            agentName,
          ),
        );
        for (const event of script.body ?? []) {
          emit(event);
        }
        emit(
          fwEvent(
            'turn_completed',
            {
              turnId,
              durationMs: 1,
            },
            agentName,
          ),
        );
      }
      return Promise.resolve();
    },
    async *getItemStream() {
      yield* script.items ?? [];
    },
    getFullStream(scope) {
      streamScopes.push(scope);
      return {
        [Symbol.asyncIterator]: () => consume(),
      };
    },
    getChannelHandle() {
      throw new Error('not impl');
    },
    getChannelStream() {
      throw new Error('not impl');
    },
    seedSessionHistory(threadId, items) {
      seeded.push({
        threadId,
        items,
      });
    },
    getStatus() {
      return {
        kind: 'idle',
      };
    },
    getQueueSize() {
      return 0;
    },
    abort() {
      return Promise.resolve();
    },
  };
}

export interface MockThread extends ChatThreadLike {
  readonly posted: Array<string | ChatStreamChunk>;
  readonly fetches: Array<{
    threadId: string;
    limit: number | undefined;
  }>;
}

export function mockThread(options: {
  id?: string;
  history?: ChatMessageLike[];
  fetchError?: Error;
}): MockThread {
  const posted: Array<string | ChatStreamChunk> = [];
  const fetches: MockThread['fetches'] = [];
  return {
    id: options.id ?? 'thread-1',
    posted,
    fetches,
    adapter: {
      fetchMessages(threadId, fetchOptions): Promise<ChatFetchResult> {
        fetches.push({
          threadId,
          limit: fetchOptions?.limit,
        });
        if (options.fetchError) {
          return Promise.reject(options.fetchError);
        }
        return Promise.resolve({
          messages: options.history ?? [],
        });
      },
    },
    async post(message) {
      for await (const chunk of message) {
        posted.push(chunk);
      }
      return posted;
    },
  };
}

/** Item ids, narrowing past ServerToolItem (the one Item variant without `id`). */
export function itemIds(items: ReadonlyArray<Item>): Array<string | null> {
  return items.map((item) => ('id' in item ? (item.id ?? null) : null));
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) {
    out.push(value);
  }
  return out;
}
