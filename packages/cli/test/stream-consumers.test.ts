import { describe, expect, test } from 'bun:test';
import type {
  HarnessResponse,
  HarnessStatus,
  StreamEvent,
  StreamingItem,
} from '../src/tui/app-parts/deps.js';
import type {
  ConsumeEventsOpts,
  ConsumeItemsOpts,
  StreamConsumerHarness,
} from '../src/tui/app-parts/stream-consumers.js';
import { consumeFullStream, consumeItemStream } from '../src/tui/app-parts/stream-consumers.js';
import type { ChatStatus, ConversationEntry, StreamMetricsRefs } from '../src/tui/app-parts/ui.js';

//#region Fixtures

function makeItem(id: string, text: string): StreamingItem {
  return {
    id,
    type: 'message',
    role: 'assistant',
    status: 'in_progress',
    content: [
      {
        type: 'output_text',
        text,
      },
    ],
    isComplete: false,
  };
}

function frameworkEvent(suffix: string, data: Record<string, unknown> = {}): StreamEvent {
  return {
    source: 'framework',
    type: `agent:${suffix}`,
    data,
  };
}

function makeResponse(): HarnessResponse {
  return {
    items: [],
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 2,
    },
    cost: 0.01,
    text: 'done',
    lastLayerUsage: undefined,
  };
}

/** Push-driven async iterable so tests control stream timing. */
function makeSource<T>(): {
  iterable: AsyncIterable<T>;
  push: (value: T) => void;
  end: () => void;
  fail: (err: Error) => void;
} {
  type Waiter = {
    resolve: (r: IteratorResult<T>) => void;
    reject: (e: Error) => void;
  };
  const queue: T[] = [];
  const waiters: Waiter[] = [];
  let done = false;
  let error: Error | null = null;

  const settle = (): void => {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter) {
        break;
      }
      if (error !== null) {
        waiter.reject(error);
        continue;
      }
      const value = queue.shift();
      if (value !== undefined) {
        waiter.resolve({
          done: false,
          value,
        });
        continue;
      }
      if (done) {
        waiter.resolve({
          done: true,
          value: undefined,
        });
        continue;
      }
      waiters.unshift(waiter);
      break;
    }
  };

  return {
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<T>>((resolve, reject) => {
            waiters.push({
              resolve,
              reject,
            });
            settle();
          }),
        return: () => {
          done = true;
          settle();
          return Promise.resolve({
            done: true,
            value: undefined,
          } satisfies IteratorResult<T>);
        },
      }),
    },
    push: (value) => {
      queue.push(value);
      settle();
    },
    end: () => {
      done = true;
      settle();
    },
    fail: (err) => {
      error = err;
      settle();
    },
  };
}

interface FakeHarnessControls {
  harness: StreamConsumerHarness;
  items: ReturnType<typeof makeSource<StreamingItem>>;
  events: ReturnType<typeof makeSource<StreamEvent>>;
  setResponse: (resp: Promise<HarnessResponse>) => void;
  setStatus: (status: HarnessStatus) => void;
}

function makeFakeHarness(): FakeHarnessControls {
  const items = makeSource<StreamingItem>();
  const events = makeSource<StreamEvent>();
  let response: Promise<HarnessResponse> = Promise.resolve(makeResponse());
  let status: HarnessStatus = {
    kind: 'idle',
  };
  return {
    harness: {
      getItemStream: () => items.iterable,
      getFullStream: () => events.iterable,
      getAgentResponse: () => response,
      getStatus: () => status,
    },
    items,
    events,
    setResponse: (resp) => {
      response = resp;
    },
    setStatus: (next) => {
      status = next;
    },
  };
}

function makeMetrics(): {
  streamMetrics: StreamMetricsRefs;
  perItemCharsRef: {
    current: Map<string, number>;
  };
} {
  return {
    streamMetrics: {
      turnStartedAt: {
        current: null,
      },
      firstTokenAt: {
        current: null,
      },
      liveOutputChars: {
        current: 0,
      },
      liveTokens: {
        current: null,
      },
    },
    perItemCharsRef: {
      current: new Map<string, number>(),
    },
  };
}

interface ItemHarnessSetup {
  controls: FakeHarnessControls;
  opts: ConsumeItemsOpts;
  entries: () => ConversationEntry[];
  setStale: () => void;
  controller: AbortController;
}

function setupItemConsumer(): ItemHarnessSetup {
  const controls = makeFakeHarness();
  const { streamMetrics, perItemCharsRef } = makeMetrics();
  const controller = new AbortController();
  let stale = false;
  let current: ConversationEntry[] = [];
  const opts: ConsumeItemsOpts = {
    harness: controls.harness,
    threadId: 't-1',
    isStale: () => stale,
    signal: controller.signal,
    setEntries: (updater) => {
      current = updater(current);
    },
    streamMetrics,
    perItemCharsRef,
  };
  return {
    controls,
    opts,
    entries: () => current,
    setStale: () => {
      stale = true;
    },
    controller,
  };
}

interface EventHarnessSetup {
  controls: FakeHarnessControls;
  opts: ConsumeEventsOpts;
  entries: () => ConversationEntry[];
  statuses: ChatStatus[];
  settled: Array<Parameters<ConsumeEventsOpts['onTurnSettled']>[0]>;
  setStale: () => void;
  controller: AbortController;
}

function setupEventConsumer(): EventHarnessSetup {
  const controls = makeFakeHarness();
  const { streamMetrics, perItemCharsRef } = makeMetrics();
  const controller = new AbortController();
  let stale = false;
  let current: ConversationEntry[] = [];
  const statuses: ChatStatus[] = [];
  const settled: Array<Parameters<ConsumeEventsOpts['onTurnSettled']>[0]> = [];
  const opts: ConsumeEventsOpts = {
    harness: controls.harness,
    threadId: 't-1',
    isStale: () => stale,
    signal: controller.signal,
    setEntries: (updater) => {
      current = updater(current);
    },
    setStatus: (s) => {
      statuses.push(s);
    },
    setLastLayerUsage: () => {},
    lastLayerUsageRef: {
      current: undefined,
    },
    pendingMessageIdsRef: {
      current: new Set<string>(),
    },
    streamMetrics,
    perItemCharsRef,
    onTurnSettled: (resp) => {
      settled.push(resp);
    },
  };
  return {
    controls,
    opts,
    entries: () => current,
    statuses,
    settled,
    setStale: () => {
      stale = true;
    },
    controller,
  };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

//#endregion

describe('consumeItemStream', () => {
  test('happy path: items land in entries and live metrics tick', async () => {
    const setup = setupItemConsumer();
    const run = consumeItemStream(setup.opts);
    setup.controls.items.push(makeItem('msg-1', 'hi'));
    setup.controls.items.push(makeItem('msg-1', 'hi there'));
    setup.controls.items.end();
    await run;
    expect(setup.entries()).toHaveLength(1);
    expect(setup.opts.streamMetrics.liveOutputChars.current).toBe('hi there'.length);
    expect(setup.opts.streamMetrics.firstTokenAt.current).not.toBeNull();
  });

  test('stale flip: items after the flip produce no entries', async () => {
    const setup = setupItemConsumer();
    const run = consumeItemStream(setup.opts);
    setup.controls.items.push(makeItem('msg-1', 'before'));
    await tick();
    expect(setup.entries()).toHaveLength(1);
    setup.setStale();
    setup.controls.items.push(makeItem('msg-2', 'after'));
    setup.controls.items.end();
    await run;
    expect(setup.entries()).toHaveLength(1);
  });

  test('abort terminates a parked loop without an error entry', async () => {
    const setup = setupItemConsumer();
    const run = consumeItemStream(setup.opts);
    await tick();
    setup.controller.abort();
    await run;
    expect(setup.entries()).toEqual([]);
  });

  test('post-stale stream error adds no error entry', async () => {
    const setup = setupItemConsumer();
    const run = consumeItemStream(setup.opts);
    await tick();
    setup.setStale();
    setup.controls.items.fail(new Error('socket reset'));
    await run;
    expect(setup.entries()).toEqual([]);
  });

  test('live stream error adds an error entry (regression)', async () => {
    const setup = setupItemConsumer();
    const run = consumeItemStream(setup.opts);
    await tick();
    setup.controls.items.fail(new Error('socket reset'));
    await run;
    const entries = setup.entries();
    expect(entries).toHaveLength(1);
    const only = entries[0];
    expect(only).toBeDefined();
    expect(only).toMatchObject({
      role: 'system',
      type: 'error',
    });
  });
});

describe('consumeFullStream', () => {
  test('happy path: turn lifecycle drives status and onTurnSettled', async () => {
    const setup = setupEventConsumer();
    const run = consumeFullStream(setup.opts);
    setup.controls.events.push(
      frameworkEvent('turn_started', {
        messageIds: [],
      }),
    );
    setup.controls.events.push(frameworkEvent('turn_completed'));
    await tick();
    setup.controls.events.end();
    await run;
    expect(setup.statuses).toEqual([
      'streaming',
      'ready',
    ]);
    expect(setup.settled).toHaveLength(1);
    expect(setup.settled[0]?.usage.inputTokens).toBe(10);
    expect(setup.opts.streamMetrics.liveTokens.current).toEqual({
      input: 10,
      output: 5,
      cached: 2,
    });
  });

  test('stale flip during getAgentResponse: no onTurnSettled, no status flip', async () => {
    const setup = setupEventConsumer();
    let resolveResponse: (resp: HarnessResponse) => void = () => {};
    setup.controls.setResponse(
      new Promise<HarnessResponse>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const run = consumeFullStream(setup.opts);
    setup.controls.events.push(
      frameworkEvent('turn_started', {
        messageIds: [],
      }),
    );
    setup.controls.events.push(frameworkEvent('turn_completed'));
    await tick();
    expect(setup.statuses).toEqual([
      'streaming',
    ]);
    // The /clear happens while getAgentResponse is still pending.
    setup.setStale();
    resolveResponse(makeResponse());
    setup.controls.events.end();
    await run;
    expect(setup.settled).toEqual([]);
    expect(setup.statuses).toEqual([
      'streaming',
    ]);
  });

  test('abort terminates a parked loop', async () => {
    const setup = setupEventConsumer();
    const run = consumeFullStream(setup.opts);
    await tick();
    setup.controller.abort();
    await run;
    expect(setup.statuses).toEqual([]);
    expect(setup.settled).toEqual([]);
  });

  test('stale flip before an event suppresses all effects', async () => {
    const setup = setupEventConsumer();
    const run = consumeFullStream(setup.opts);
    await tick();
    setup.setStale();
    setup.controls.events.push(
      frameworkEvent('turn_started', {
        messageIds: [],
      }),
    );
    setup.controls.events.end();
    await run;
    expect(setup.statuses).toEqual([]);
    expect(setup.settled).toEqual([]);
    expect(setup.entries()).toEqual([]);
  });
});
