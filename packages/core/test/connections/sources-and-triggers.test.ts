import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type {
  ConnectionEventInit,
  ConnectionTrigger,
  EventStreamMessage,
} from '@noetic-tools/types';
import { isConnectionUnsatisfiedError, isNoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import { cronMatches, nextCronRun, parseCronSchedule } from '../../src/connections/cron-schedule';
import { bufferedEventStream } from '../../src/connections/event-stream';
import { createInMemoryConnection } from '../../src/connections/in-memory-connection';
import { createConnectionRuntime } from '../../src/connections/registry';
import { cron, defineSource } from '../../src/connections/sources';
import type { TriggerDelivery } from '../../src/connections/triggers';
import { TriggerRunner, validateTriggers } from '../../src/connections/triggers';
import { createInMemoryArtifactStore } from '../../src/runtime/in-memory-artifact-store';
import { makeStorage, sleep } from '../_helpers';

//#region Fixtures

const DeployFailedSchema = z.object({
  service: z.string(),
});

function deploySource(): ReturnType<
  typeof defineSource<{
    'deploy.failed': typeof DeployFailedSchema;
  }>
> {
  return defineSource({
    events: {
      'deploy.failed': DeployFailedSchema,
    },
  });
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

async function take<T>(iterable: AsyncIterable<T>, count: number): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
    if (out.length >= count) {
      break;
    }
  }
  return out;
}

async function until(predicate: () => boolean | Promise<boolean>, ms = 500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting');
    }
    await sleep(2);
  }
}

//#endregion

describe('cron schedules', () => {
  test('parse fields, lists, ranges and steps', () => {
    const schedule = parseCronSchedule('*/15 8-9 1,15 * 1-5');
    expect([
      ...schedule.minutes,
    ]).toEqual([
      0,
      15,
      30,
      45,
    ]);
    expect([
      ...schedule.hours,
    ]).toEqual([
      8,
      9,
    ]);
    expect(parseCronSchedule('0 0 * * 7').weekdays.has(0)).toBe(true);
    expect([
      ...parseCronSchedule('10/20 * * * *').minutes,
    ]).toEqual([
      10,
      30,
      50,
    ]);
  });

  const invalid: ReadonlyArray<
    readonly [
      string,
      string?,
    ]
  > = [
    [
      '* * * *',
    ],
    [
      '60 * * * *',
    ],
    [
      'x * * * *',
    ],
    [
      '5-1 * * * *',
    ],
    [
      '* * * * *',
      'Not/AZone',
    ],
  ];
  for (const [schedule, timezone] of invalid) {
    test(`'${schedule}' ${timezone ?? ''} is CONNECTION_INVALID`, () => {
      const e = thrown(() => parseCronSchedule(schedule, timezone));
      expect(isNoeticConfigError(e) && e.code).toBe('CONNECTION_INVALID');
    });
  }

  test('nextCronRun finds the next scheduled minute in the timezone', () => {
    const daily = parseCronSchedule('0 8 * * *', 'America/New_York');
    const after = Date.parse('2026-03-01T12:00:00Z');
    expect(new Date(nextCronRun(daily, after) ?? 0).toISOString()).toBe('2026-03-01T13:00:00.000Z');
    const everyMinute = parseCronSchedule('* * * * *');
    expect(nextCronRun(everyMinute, Date.parse('2026-01-01T00:00:30Z'))).toBe(
      Date.parse('2026-01-01T00:01:00Z'),
    );
    expect(cronMatches(everyMinute, Date.parse('2026-01-01T00:00:00Z'))).toBe(true);
  });

  test('does not skip the run after the clocks go forward', () => {
    // Regression: skipping "the rest of today" assumed a 24-hour day. Sunday 8 March
    // 2026 is 23 hours long in New York, so the skip landed past Monday's midnight.
    const mondays = parseCronSchedule('0 0 * * 1', 'America/New_York');
    const runs: string[] = [];
    let after = Date.parse('2026-03-02T12:00:00Z');
    for (let i = 0; i < 4; i += 1) {
      const next = nextCronRun(mondays, after);
      assert(next !== undefined);
      runs.push(new Date(next).toISOString());
      after = next;
    }
    expect(runs).toEqual([
      // Midnight is 05:00 UTC until the change, 04:00 UTC after it.
      '2026-03-09T04:00:00.000Z',
      '2026-03-16T04:00:00.000Z',
      '2026-03-23T04:00:00.000Z',
      '2026-03-30T04:00:00.000Z',
    ]);
  });

  test('keeps to local time when the clocks go back', () => {
    const daily = parseCronSchedule('30 9 * * *', 'America/New_York');
    const before = nextCronRun(daily, Date.parse('2026-10-31T00:00:00Z'));
    const onTheDay = nextCronRun(daily, Date.parse('2026-11-01T00:00:00Z'));
    const after = nextCronRun(daily, Date.parse('2026-11-02T00:00:00Z'));
    expect(
      [
        before,
        onTheDay,
        after,
      ].map((ms) => new Date(ms ?? 0).toISOString()),
    ).toEqual([
      '2026-10-31T13:30:00.000Z',
      '2026-11-01T14:30:00.000Z',
      '2026-11-02T14:30:00.000Z',
    ]);
  });

  test('either day field matches when both are restricted', () => {
    const schedule = parseCronSchedule('0 0 13 * 5');
    expect(cronMatches(schedule, Date.parse('2026-02-13T00:00:00Z'))).toBe(true);
    expect(cronMatches(schedule, Date.parse('2026-02-06T00:00:00Z'))).toBe(true);
    expect(cronMatches(schedule, Date.parse('2026-02-07T00:00:00Z'))).toBe(false);
  });

  test('a schedule that never matches returns undefined', () => {
    expect(nextCronRun(parseCronSchedule('0 0 31 2 *'), Date.now())).toBeUndefined();
  });
});

describe('defineSource', () => {
  test('host emits reach listeners; events emitted before anyone listens are held', async () => {
    const source = deploySource();
    const [connection] = await source.connect({
      name: 'deploys',
      signal: new AbortController().signal,
      artifacts: createInMemoryArtifactStore(),
    });
    if (!connection) {
      throw new Error('no connection');
    }
    expect(connection.manifest.events['deploy.failed']?.replay).toBe('live');
    await source.emit({
      type: 'deploy.failed',
      id: 'd1',
      payload: {
        service: 'api',
      },
    });
    const stream = connection.listen({
      event: 'deploy.failed',
      signal: new AbortController().signal,
    });
    await source.emit({
      type: 'deploy.failed',
      id: 'd2',
      payload: {
        service: 'web',
      },
      cursor: '7',
    });
    const messages = await take(stream, 2);
    expect(messages.map((m) => (m.type === 'event' ? m.event.id : m.type))).toEqual([
      'd1',
      'd2',
    ]);
    const second = messages[1];
    expect(second?.type === 'event' && second.event.cursor).toBe('7');
    expect(
      await connection.call(
        'x',
        {},
        {
          signal: new AbortController().signal,
          idempotencyKey: 'k',
        },
      ),
    ).toMatchObject({
      status: 'error',
    });
    await connection.release();
  });

  test('a payload that fails its schema, or an unknown event, is CONNECTION_INVALID', async () => {
    const source = deploySource();
    const bad = await rejected(
      source.emit({
        type: 'deploy.failed',
        id: 'd1',
        payload: JSON.parse('{"service":3}'),
      }),
    );
    expect(isNoeticConfigError(bad) && bad.code).toBe('CONNECTION_INVALID');
    const unknown = await rejected(
      source.emit(JSON.parse('{"type":"deploy.other","id":"x","payload":{}}')),
    );
    expect(isNoeticConfigError(unknown) && unknown.code).toBe('CONNECTION_INVALID');
  });

  test('start runs once a listener subscribes, with the recorded cursor', async () => {
    const cursors: Array<string | null> = [];
    const source = defineSource({
      events: {
        tick: z.object({
          n: z.number(),
        }),
      },
      async start({ emit, cursor }) {
        cursors.push(cursor);
        await emit({
          type: 'tick',
          id: 'n1',
          payload: {
            n: 1,
          },
          cursor: '1',
        });
      },
    });
    const [connection] = await source.connect({
      name: 'ticks',
      signal: new AbortController().signal,
      artifacts: createInMemoryArtifactStore(),
    });
    if (!connection) {
      throw new Error('no connection');
    }
    expect(connection.manifest.events.tick?.replay).toBe('durable');
    const stream = connection.listen({
      event: 'tick',
      cursor: '0',
      signal: new AbortController().signal,
    });
    const [message] = await take(stream, 1);
    expect(message?.type).toBe('event');
    expect(cursors).toEqual([
      '0',
    ]);
  });
});

describe('a source that emits without cursors', () => {
  test('listening again from where a listener began replays only what came since', async () => {
    const DoneSchema = z.object({
      n: z.number(),
    });
    let emitNext: ((n: number) => Promise<void>) | undefined;
    const source = defineSource({
      events: {
        done: DoneSchema,
      },
      async start({ emit, signal }) {
        emitNext = (n) =>
          emit({
            type: 'done',
            id: `e${n}`,
            payload: {
              n,
            },
          });
        await new Promise((resolve) =>
          signal.addEventListener('abort', resolve, {
            once: true,
          }),
        );
      },
    });
    const [connection] = await source.connect({
      name: 'jobs',
      signal: new AbortController().signal,
      artifacts: createInMemoryArtifactStore(),
    });
    assert(connection);
    const listen = (cursor?: string | null) =>
      connection.listen({
        event: 'done',
        cursor,
        signal: new AbortController().signal,
      });
    // Someone listens, and three events go by.
    const early = listen();
    await sleep(5);
    assert(emitNext);
    for (const n of [
      1,
      2,
      3,
    ]) {
      await emitNext(n);
    }
    await take(early, 3);

    // A wait begins now, and records where the source is.
    const wait = listen();
    const { cursor } = await wait.ready;
    assert(cursor);
    await emitNext(4);
    await wait.close();

    // It listens again from there (its turn was parked and woken): event 4 is
    // what it missed. Events 1 to 3 came before it began.
    const again = listen(cursor);
    const replayed = await take(again, 1);
    expect(replayed.map((m) => (m.type === 'event' ? m.event.id : m.type))).toEqual([
      'e4',
    ]);
    await connection.release();
  });
});

describe('cron()', () => {
  test('two listeners each get what they missed, from their own cursors', async () => {
    const source = cron('* * * * *');
    const [connection] = await source.connect({
      name: 'clock',
      signal: new AbortController().signal,
      artifacts: createInMemoryArtifactStore(),
    });
    assert(connection);
    const minute = 6e4;
    const ago = (minutes: number): string =>
      new Date(Math.floor(Date.now() / minute) * minute - minutes * minute).toISOString();
    const listen = (cursor: string) =>
      connection.listen({
        event: 'tick',
        cursor,
        signal: new AbortController().signal,
      });
    // The one that listens first is the one that is nearly up to date.
    const recent = listen(ago(1));
    const behind = listen(ago(3));
    const ids = (messages: EventStreamMessage[]): string[] =>
      messages.map((m) => (m.type === 'event' ? m.event.id : m.type));
    expect(ids(await take(recent, 1))).toEqual([
      ago(0),
    ]);
    expect(ids(await take(behind, 3))).toEqual([
      ago(2),
      ago(1),
      ago(0),
    ]);
    await connection.release();
  });

  test('delivers every tick missed since the cursor, each once', async () => {
    const source = cron('* * * * *');
    const [connection] = await source.connect({
      name: 'morning',
      signal: new AbortController().signal,
      artifacts: createInMemoryArtifactStore(),
    });
    if (!connection) {
      throw new Error('no connection');
    }
    const minute = 6e4;
    const lastRecorded = new Date(
      Math.floor(Date.now() / minute) * minute - 3 * minute,
    ).toISOString();
    const stream = connection.listen({
      event: 'tick',
      cursor: lastRecorded,
      signal: new AbortController().signal,
    });
    const ticks = await take(stream, 3);
    const ids = ticks.map((t) => (t.type === 'event' ? t.event.id : ''));
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => Date.parse(id) > Date.parse(lastRecorded))).toBe(true);
    await connection.release();
  });
});

describe('bufferedEventStream', () => {
  test('overflow drops the oldest events and records a gap', async () => {
    const provider = createInMemoryConnection({
      events: {
        e: {},
      },
    });
    const [connection] = await provider.connect({
      name: 'x',
      signal: new AbortController().signal,
      artifacts: createInMemoryArtifactStore(),
    });
    if (!connection) {
      throw new Error('no connection');
    }
    const changes: string[] = [];
    const stream = bufferedEventStream(
      connection.listen({
        event: 'e',
        signal: new AbortController().signal,
      }),
      {
        limit: 2,
        transform: async (event: ConnectionEventInit) => ({
          ...event,
          connection: 'x',
        }),
        onChange: (c) => changes.push(c.change),
      },
    );
    await stream.ready;
    await sleep(0);
    for (const n of [
      1,
      2,
      3,
      4,
    ]) {
      provider.connection.emit('e', n);
    }
    await sleep(5);
    const messages: EventStreamMessage[] = await take(stream, 3);
    expect(messages[0]?.type).toBe('gap');
    expect(messages.slice(1).map((m) => (m.type === 'event' ? m.event.payload : null))).toEqual([
      3,
      4,
    ]);
    expect(changes).toContain('gap');
    await stream.close();
  });
});

describe('triggers', () => {
  function setup(): {
    readonly source: ReturnType<typeof deploySource>;
    readonly storage: ReturnType<typeof makeStorage>;
    readonly runtime: ReturnType<typeof createConnectionRuntime>;
  } {
    const source = deploySource();
    const storage = makeStorage();
    const runtime = createConnectionRuntime({
      connections: {
        deploys: source,
      },
      storage,
      artifacts: createInMemoryArtifactStore(),
    });
    return {
      source,
      storage,
      runtime,
    };
  }

  test('validateTriggers rejects unknown connections and bad ids', () => {
    const unknown = thrown(() =>
      validateTriggers(
        [
          {
            id: 't',
            connection: 'nope',
            event: 'x',
            input: () => '',
          },
        ],
        [
          'deploys',
        ],
      ),
    );
    expect(isNoeticConfigError(unknown) && unknown.code).toBe('CONNECTION_UNKNOWN');
    const repeated = thrown(() =>
      validateTriggers(
        [
          {
            id: 't',
            connection: 'deploys',
            event: 'x',
            input: () => '',
          },
          {
            id: 't',
            connection: 'deploys',
            event: 'x',
            input: () => '',
          },
        ],
        [
          'deploys',
        ],
      ),
    );
    expect(isNoeticConfigError(repeated) && repeated.code).toBe('CONNECTION_INVALID');
    const noEvent = thrown(() =>
      validateTriggers(
        [
          {
            id: 't',
            connection: 'deploys',
            event: '',
            input: () => '',
          },
        ],
        [
          'deploys',
        ],
      ),
    );
    expect(isNoeticConfigError(noEvent) && noEvent.code).toBe('CONNECTION_INVALID');
  });

  test('an event the connection does not offer is CONNECTION_UNSATISFIED at start', async () => {
    const { runtime, storage } = setup();
    await runtime.start();
    const runner = new TriggerRunner({
      runtime,
      storage,
      triggers: [
        {
          id: 'x',
          connection: 'deploys',
          event: 'deploy.succeeded',
          input: () => '',
        },
      ],
      deliver: async () => undefined,
    });
    const e = await rejected(runner.start());
    expect(isConnectionUnsatisfiedError(e)).toBe(true);
  });

  test('matching events become turns on their thread, once each, filtered here', async () => {
    const { runtime, storage, source } = setup();
    await runtime.start();
    const delivered: TriggerDelivery[] = [];
    const runner = new TriggerRunner({
      runtime,
      storage,
      triggers: [
        {
          id: 'failures',
          connection: 'deploys',
          event: 'deploy.failed',
          filter: (e) =>
            z
              .object({
                service: z.string(),
              })
              .parse(e.payload).service !== 'ignored',
          input: (e) => `Deploy failed: ${JSON.stringify(e.payload)}`,
          thread: (e) =>
            `deploy-${
              z
                .object({
                  service: z.string(),
                })
                .parse(e.payload).service
            }`,
        },
      ],
      deliver: async (d) => {
        delivered.push(d);
      },
    });
    await runner.start();
    await sleep(5);
    await source.emit({
      type: 'deploy.failed',
      id: 'd1',
      payload: {
        service: 'api',
      },
      cursor: '1',
    });
    await source.emit({
      type: 'deploy.failed',
      id: 'd1',
      payload: {
        service: 'api',
      },
      cursor: '1',
    });
    await source.emit({
      type: 'deploy.failed',
      id: 'd2',
      payload: {
        service: 'ignored',
      },
      cursor: '2',
    });
    await until(() => delivered.length >= 1);
    await sleep(10);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      trigger: 'failures',
      connection: 'deploys',
      threadId: 'deploy-api',
      messageId: 'deploys:failures:d1',
      input: 'Deploy failed: {"service":"api"}',
    });
    expect(delivered[0]?.event.connection).toBe('deploys');
    expect(await storage.get('noetic/connections/triggers/failures/cursor')).toBe('2');
    expect(await storage.list('noetic/connections/triggers/failures/inbox/')).toEqual([]);
    await runner.close();
    await runtime.close();
  });

  test('a filter that throws dead-letters that event and moves on; a failed turn is retried', async () => {
    const { runtime, storage, source } = setup();
    await runtime.start();
    const delivered: string[] = [];
    let failOnce = true;
    const errors: unknown[] = [];
    const runner = new TriggerRunner({
      runtime,
      storage,
      triggers: [
        {
          id: 'failures',
          connection: 'deploys',
          event: 'deploy.failed',
          filter: (e) => {
            if (e.id === 'poison') {
              throw new Error('bad filter');
            }
            return true;
          },
          input: (e) => e.id,
        },
      ],
      deliver: async (d) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('turn failed');
        }
        delivered.push(d.input);
      },
      onError: (_trigger, error) => errors.push(error),
      relistenDelayMs: () => 1,
      redeliverDelayMs: () => 1,
    });
    await runner.start();
    await sleep(5);
    await source.emit({
      type: 'deploy.failed',
      id: 'poison',
      payload: {
        service: 'api',
      },
      cursor: '1',
    });
    await source.emit({
      type: 'deploy.failed',
      id: 'next',
      payload: {
        service: 'api',
      },
      cursor: '2',
    });
    await until(() => delivered.length >= 1);
    expect(delivered).toEqual([
      'next',
    ]);
    expect(errors).toHaveLength(2);
    expect(await storage.get('noetic/connections/triggers/failures/cursor')).toBe('2');
    expect(await storage.list('noetic/connections/triggers/failures/inbox/')).toEqual([]);
    await runner.close();
    await runtime.close();
  });

  test('events on one thread are delivered one turn at a time, each its own turn', async () => {
    const { runtime, storage, source } = setup();
    await runtime.start();
    let active = 0;
    let overlapped = false;
    const turns: string[] = [];
    const runner = new TriggerRunner({
      runtime,
      storage,
      triggers: [
        {
          id: 'failures',
          connection: 'deploys',
          event: 'deploy.failed',
          input: (e) => e.id,
          thread: () => 'one-thread',
        },
      ],
      deliver: async (d) => {
        active += 1;
        overlapped ||= active > 1;
        await sleep(5);
        turns.push(d.input);
        active -= 1;
      },
    });
    await runner.start();
    await sleep(5);
    for (const id of [
      'a',
      'b',
      'c',
    ]) {
      await source.emit({
        type: 'deploy.failed',
        id,
        payload: {
          service: 'api',
        },
        cursor: id,
      });
    }
    await until(() => turns.length >= 3);
    expect(turns).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(overlapped).toBe(false);
    await runner.close();
    await runtime.close();
  });

  test('an undelivered inbox entry is delivered again on start', async () => {
    const { runtime, storage } = setup();
    await storage.set('noetic/connections/triggers/failures/inbox/d9', {
      event: {
        id: 'd9',
        type: 'deploy.failed',
        time: new Date().toISOString(),
        payload: {
          service: 'api',
        },
        cursor: '9',
        connection: 'deploys',
      },
      threadId: 'failures',
      input: 'again',
      messageId: 'deploys:failures:d9',
    });
    await storage.set('noetic/connections/triggers/failures/inbox/garbage', {
      nope: true,
    });
    await runtime.start();
    const delivered: string[] = [];
    const runner = new TriggerRunner({
      runtime,
      storage,
      triggers: [
        {
          id: 'failures',
          connection: 'deploys',
          event: 'deploy.failed',
          input: () => 'x',
        },
      ],
      deliver: async (d) => {
        delivered.push(d.messageId);
      },
    });
    await runner.start();
    await until(() => delivered.length === 1);
    await sleep(5);
    expect(delivered).toEqual([
      'deploys:failures:d9',
    ]);
    expect(await storage.get('noetic/connections/triggers/failures/seen/d9')).toBe(true);
    expect(await storage.get('noetic/connections/triggers/failures/inbox/garbage')).toBeNull();
    await runner.close();
  });

  test("the profile's natural thread is used when the trigger names none", async () => {
    const chat = createInMemoryConnection({
      events: {
        'chat.message.created': {
          thread: 'thread',
        },
      },
    });
    const storage = makeStorage();
    const runtime = createConnectionRuntime({
      connections: {
        slack: chat,
      },
      storage,
      artifacts: createInMemoryArtifactStore(),
    });
    await runtime.start();
    const delivered: TriggerDelivery[] = [];
    const errors: unknown[] = [];
    const runner = new TriggerRunner({
      runtime,
      storage,
      triggers: [
        {
          id: 'mentions',
          connection: 'slack',
          event: 'chat.message.created',
          input: () => 'hi',
        },
      ],
      deliver: async (d) => {
        delivered.push(d);
        throw new Error('turn failed');
      },
      onError: (_trigger, error) => errors.push(error),
    });
    await runner.start();
    await sleep(5);
    chat.connection.emit('chat.message.created', {
      thread: {
        $ref: {
          kind: 'chat.thread',
          id: 'T1',
        },
      },
    });
    await until(() => delivered.length === 1 && errors.length === 1);
    expect(delivered[0]?.threadId).toBe('slack:T1');
    expect(await storage.list('noetic/connections/triggers/mentions/inbox/')).toHaveLength(1);
    await runner.close();
  });

  /** A runner over `setup()` with one trigger and no delays between tries. */
  function runnerFor(
    rig: ReturnType<typeof setup>,
    options: {
      triggers: ConnectionTrigger[];
      deliver: (d: TriggerDelivery) => Promise<void>;
      errors?: unknown[];
    },
  ): TriggerRunner {
    return new TriggerRunner({
      runtime: rig.runtime,
      storage: rig.storage,
      triggers: options.triggers,
      deliver: options.deliver,
      onError: (_trigger, error) => options.errors?.push(error),
      relistenDelayMs: () => 1,
      redeliverDelayMs: () => 0,
      now: () => 4242,
    });
  }

  function failed(
    id: string,
    service = 'api',
  ): {
    type: 'deploy.failed';
    id: string;
    payload: {
      service: string;
    };
  } {
    return {
      type: 'deploy.failed',
      id,
      payload: {
        service,
      },
    };
  }

  test('emit resolves only once the trigger has the event in its inbox', async () => {
    const rig = setup();
    await rig.runtime.start();
    // The turn never finishes, so the inbox entry stays where the test can see it.
    const runner = runnerFor(rig, {
      triggers: [
        {
          id: 'failures',
          connection: 'deploys',
          event: 'deploy.failed',
          input: (e) => e.id,
        },
      ],
      deliver: () => new Promise(() => {}),
    });
    await runner.start();
    await sleep(5);

    await rig.source.emit(failed('e1'));
    // No waiting here: by the time emit resolved, the event was stored.
    expect(await rig.storage.list('noetic/connections/triggers/failures/inbox/')).toHaveLength(1);
    void runner.close();
    await rig.runtime.close();
  });

  test('emit rejects when the trigger could not store the event', async () => {
    const rig = setup();
    await rig.runtime.start();
    const store = rig.storage.set.bind(rig.storage);
    rig.storage.set = async (key: string, value: unknown) => {
      if (key.includes('/inbox/')) {
        throw new Error('disk full');
      }
      await store(key, value);
    };
    const runner = runnerFor(rig, {
      triggers: [
        {
          id: 'failures',
          connection: 'deploys',
          event: 'deploy.failed',
          input: (e) => e.id,
        },
      ],
      deliver: async () => {},
      errors: [],
    });
    await runner.start();
    await sleep(5);

    const error = await rejected(rig.source.emit(failed('e1')));
    assert(error instanceof Error);
    expect(error.message).toContain('disk full');
    await runner.close();
    await rig.runtime.close();
  });

  test('emit rejects while the trigger is away after a failed write, and the trigger comes back', async () => {
    const rig = setup();
    await rig.runtime.start();
    let failing = true;
    const store = rig.storage.set.bind(rig.storage);
    rig.storage.set = async (key: string, value: unknown) => {
      if (failing && key.includes('/inbox/')) {
        throw new Error('disk full');
      }
      await store(key, value);
    };
    const delivered: string[] = [];
    const runner = new TriggerRunner({
      runtime: rig.runtime,
      storage: rig.storage,
      triggers: [
        {
          id: 'failures',
          connection: 'deploys',
          event: 'deploy.failed',
          input: (e) => e.id,
        },
      ],
      deliver: async (d) => {
        delivered.push(d.input);
      },
      onError: () => {},
      // Long enough to emit into the gap before the trigger listens again.
      relistenDelayMs: () => 60,
      redeliverDelayMs: () => 0,
    });
    await runner.start();
    await sleep(5);

    const first = await rejected(rig.source.emit(failed('e1')));
    assert(first instanceof Error);
    expect(first.message).toContain('disk full');
    // The trigger is backing off. The event has nowhere durable to go, and the
    // sender is told so instead of being told it was taken.
    failing = false;
    const second = await rejected(rig.source.emit(failed('e2')));
    assert(second instanceof Error);
    expect(second.message).toContain('not stored');
    expect(await rig.storage.list('noetic/connections/triggers/failures/inbox/')).toEqual([]);

    // The trigger listens again: the sender's retry goes through.
    await sleep(120);
    await rig.source.emit(failed('e2'));
    await until(() => delivered.includes('e2'));
    await runner.close();
    await rig.runtime.close();
  });

  test('a source with a start loop survives an event that could not be stored', async () => {
    const storage = makeStorage();
    let starts = 0;
    const ticks = defineSource({
      events: {
        tick: z.object({}),
      },
      async start({ emit, cursor, signal }) {
        starts += 1;
        for (let n = cursor === null ? 1 : Number(cursor) + 1; n <= 3 && !signal.aborted; n += 1) {
          await emit({
            type: 'tick',
            id: `tick-${n}`,
            cursor: String(n),
            payload: {},
          });
        }
      },
    });
    const runtime = createConnectionRuntime({
      connections: {
        ticks,
      },
      storage,
      artifacts: createInMemoryArtifactStore(),
    });
    await runtime.start();
    let failures = 1;
    const store = storage.set.bind(storage);
    storage.set = async (key: string, value: unknown) => {
      if (failures > 0 && key.includes('/inbox/')) {
        failures -= 1;
        throw new Error('blip');
      }
      await store(key, value);
    };
    const delivered: string[] = [];
    const runner = new TriggerRunner({
      runtime,
      storage,
      triggers: [
        {
          id: 'on-tick',
          connection: 'ticks',
          event: 'tick',
          input: (e) => e.id,
        },
      ],
      deliver: async (d) => {
        delivered.push(d.input);
      },
      onError: () => {},
      relistenDelayMs: () => 1,
      redeliverDelayMs: () => 0,
    });
    await runner.start();
    await until(() => delivered.length === 3);
    // The loop was started again after the failure, and no tick was lost.
    expect(starts).toBe(2);
    expect(delivered).toEqual([
      'tick-1',
      'tick-2',
      'tick-3',
    ]);
    await runner.close();
    await runtime.close();
  });

  test('a trigger that gives up on an event says which one, on the stream', async () => {
    const source = deploySource();
    const storage = makeStorage();
    const events: Array<{
      type: string;
      data: unknown;
    }> = [];
    const runtime = createConnectionRuntime({
      connections: {
        deploys: source,
      },
      storage,
      artifacts: createInMemoryArtifactStore(),
      onFrameworkEvent: (event) => events.push(event),
    });
    await runtime.start();
    const runner = new TriggerRunner({
      runtime,
      storage,
      triggers: [
        {
          id: 'failures',
          connection: 'deploys',
          event: 'deploy.failed',
          input: (e) => e.id,
        },
      ],
      deliver: async () => {
        throw new Error('model is down');
      },
      onError: () => {},
      relistenDelayMs: () => 1,
      redeliverDelayMs: () => 0,
    });
    await runner.start();
    await sleep(5);
    await source.emit(failed('e1'));
    await until(() => events.some((event) => event.type === 'trigger_gave_up'));
    const gaveUp = events.find((event) => event.type === 'trigger_gave_up');
    expect(gaveUp?.data).toMatchObject({
      connection: 'deploys',
      trigger: 'failures',
      attempts: 5,
      error: 'model is down',
      event: {
        id: 'e1',
      },
    });
    await runner.close();
    await runtime.close();
  });

  test('a trigger kept from an earlier run that no longer fits does not stop the others', async () => {
    const rig = setup();
    await rig.storage.set('noetic/connections/triggers-added/stale', {
      id: 'stale',
      connection: 'deploys',
      event: 'deploy.renamed-away',
      input: 'event.id',
    });
    await rig.runtime.start();
    const delivered: string[] = [];
    const errors: unknown[] = [];
    const runner = runnerFor(rig, {
      triggers: [
        {
          id: 'failures',
          connection: 'deploys',
          event: 'deploy.failed',
          input: (e) => e.id,
        },
      ],
      deliver: async (d) => {
        delivered.push(d.input);
      },
      errors,
    });
    await runner.start();
    await sleep(5);
    await rig.source.emit(failed('e1'));
    await until(() => delivered.length === 1);
    expect(errors).toHaveLength(1);
    expect(runner.list().map((trigger) => trigger.id)).toEqual([
      'failures',
    ]);
    await runner.close();
    await rig.runtime.close();
  });

  test('emit resolves at once when no trigger listens: the event waits in memory', async () => {
    const rig = setup();
    await rig.runtime.start();
    await rig.source.emit(failed('e1'));
    await rig.runtime.close();
  });

  test('a trigger written as data filters, names its thread and builds its input by expression', async () => {
    const rig = setup();
    await rig.runtime.start();
    const delivered: TriggerDelivery[] = [];
    const runner = runnerFor(rig, {
      triggers: [
        {
          id: 'api-failures',
          connection: 'deploys',
          event: 'deploy.failed',
          filter: 'event.payload.service = "api"',
          input: '"Deploy of " & event.payload.service & " failed (" & event.id & ")"',
          thread: '"service:" & event.payload.service',
        },
      ],
      deliver: async (d) => {
        delivered.push(d);
      },
    });
    await runner.start();
    await sleep(5);

    await rig.source.emit(failed('e1', 'web'));
    await rig.source.emit(failed('e2', 'api'));
    await until(() => delivered.length >= 1);
    expect(delivered.map((d) => d.input)).toEqual([
      'Deploy of api failed (e2)',
    ]);
    expect(delivered[0]?.threadId).toBe('service:api');
    await runner.close();
    await rig.runtime.close();
  });

  test('an expression that does not parse is CONNECTION_INVALID', () => {
    const e = thrown(() =>
      validateTriggers(
        [
          {
            id: 'bad',
            connection: 'deploys',
            event: 'deploy.failed',
            filter: 'event.payload.service = ',
            input: 'event.id',
          },
        ],
        [
          'deploys',
        ],
      ),
    );
    assert(isNoeticConfigError(e));
    expect(e.code).toBe('CONNECTION_INVALID');
    expect(e.message).toContain('filter');
  });

  test('a data trigger added while running is kept, and is there after a restart', async () => {
    const rig = setup();
    await rig.runtime.start();
    const delivered: string[] = [];
    const deliver = async (d: TriggerDelivery): Promise<void> => {
      delivered.push(d.input);
    };
    const first = runnerFor(rig, {
      triggers: [],
      deliver,
    });
    await first.start();
    await first.add({
      id: 'added',
      connection: 'deploys',
      event: 'deploy.failed',
      input: 'event.id',
    });
    expect(first.list().map((t) => t.id)).toEqual([
      'added',
    ]);
    await sleep(5);
    await rig.source.emit(failed('e1'));
    await until(() => delivered.length === 1);
    await first.close();

    // A new runner, as after a restart, given no triggers of its own.
    const second = runnerFor(rig, {
      triggers: [],
      deliver,
    });
    await second.start();
    expect(second.list().map((t) => t.id)).toEqual([
      'added',
    ]);
    await sleep(5);
    await rig.source.emit(failed('e2'));
    await until(() => delivered.length === 2);
    expect(delivered).toEqual([
      'e1',
      'e2',
    ]);

    // Removed, it stops firing and is gone after the next restart too.
    expect(await second.remove('added')).toBe(true);
    expect(await second.remove('added')).toBe(false);
    await second.close();
    const third = runnerFor(rig, {
      triggers: [],
      deliver,
    });
    await third.start();
    expect(third.list()).toEqual([]);
    await third.close();
    await rig.runtime.close();
  });

  test('adding a trigger whose id is taken is CONNECTION_INVALID', async () => {
    const rig = setup();
    await rig.runtime.start();
    const trigger = {
      id: 'dup',
      connection: 'deploys',
      event: 'deploy.failed',
      input: 'event.id',
    };
    const runner = runnerFor(rig, {
      triggers: [
        trigger,
      ],
      deliver: async () => {},
    });
    await runner.start();
    const e = await rejected(runner.add(trigger));
    assert(isNoeticConfigError(e));
    expect(e.code).toBe('CONNECTION_INVALID');
    await runner.close();
    await rig.runtime.close();
  });

  test('an event whose turn keeps failing is given up on after five tries, and not tried again', async () => {
    const rig = setup();
    await rig.runtime.start();
    let tries = 0;
    const delivered: string[] = [];
    const errors: unknown[] = [];
    const options = {
      triggers: [
        {
          id: 'failures',
          connection: 'deploys',
          event: 'deploy.failed',
          input: 'event.id',
        },
      ],
      deliver: async (d: TriggerDelivery): Promise<void> => {
        tries += 1;
        delivered.push(d.input);
        throw new Error('model is down');
      },
      errors,
    };
    const runner = runnerFor(rig, options);
    await runner.start();
    await sleep(5);
    await rig.source.emit(failed('e1'));
    await until(() => tries === 5);
    await until(
      async () =>
        (await rig.storage.list('noetic/connections/triggers/failures/inbox/')).length === 0,
    );

    // Each failed try was reported; nothing is kept but the mark that it was seen.
    expect(errors).toHaveLength(5);
    expect(await rig.storage.get('noetic/connections/triggers/failures/seen/e1')).toEqual({
      failed: 'model is down',
    });
    expect(await rig.storage.list('noetic/connections/triggers/failures/dead/')).toEqual([]);
    await runner.close();

    // Not tried again after a restart, nor when the source delivers it again.
    const restarted = runnerFor(rig, options);
    await restarted.start();
    await sleep(10);
    await rig.source.emit(failed('e1'));
    await sleep(10);
    expect(tries).toBe(5);
    expect(delivered).toHaveLength(5);
    await restarted.close();
    await rig.runtime.close();
  });
});
