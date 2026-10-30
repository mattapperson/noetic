import { describe, expect, test } from 'bun:test';
import type { ConnectionEventInit, EventStreamMessage } from '@noetic-tools/types';
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

async function until(predicate: () => boolean, ms = 500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
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

describe('cron()', () => {
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
});
