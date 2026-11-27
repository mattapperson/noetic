// Scheduled sources and a host with no process between events: the harness says
// when it next has something to do, a trigger counts from a stored place, and
// `idle()` waits for what is due. See specs/35-connections § Triggers and
// specs/23-durable-execution § Parked turns.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { ContextData } from '@noetic-tools/types';
import { z } from 'zod';
import { callModel } from '../../src/builders/step-builders';
import { cron, defineSource } from '../../src/connections/sources';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { assistantMessage } from '../_helpers';

//#region Fixtures

const MINUTE = 6e4;
const CURSOR_KEY = 'noetic/connections/triggers/every-minute/cursor';

const agent = callModel<ContextData, string, string>({
  id: 'agent',
  model: 'test/model',
});

/** A harness with one trigger on a `cron()` that ticks every minute. */
function everyMinute(storage: StorageAdapter, ticks: string[]): AgentHarness {
  return new AgentHarness({
    name: 'schedule',
    params: {},
    agentGraph: agent,
    connections: {
      clock: cron('* * * * *'),
    },
    triggerTurnOn: [
      {
        id: 'every-minute',
        connection: 'clock',
        event: 'tick',
        input: 'event.payload.scheduledFor',
        thread: '"tick:" & event.id',
      },
    ],
    environment: {
      storage: {
        adapter: storage,
      },
    },
    _testCallModel: async (request) => {
      ticks.push(JSON.stringify(request));
      return {
        items: [
          assistantMessage('done'),
        ],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
        },
      };
    },
  });
}

/** The start of the minute `minutes` before the current one. */
function minuteAgo(minutes: number): number {
  return Math.floor(Date.now() / MINUTE) * MINUTE - minutes * MINUTE;
}

//#endregion

describe('harness.getNextWakeTime() with a cron trigger', () => {
  it('is the next tick, counted from a place the trigger stores when it first starts', async () => {
    const storage = createInMemoryStorage();
    const harness = everyMinute(storage, []);
    const before = Date.now();
    await harness.start();

    const stored = await storage.get<string>(CURSOR_KEY);
    assert(stored);
    expect(Date.parse(stored)).toBeGreaterThanOrEqual(before);

    const next = await harness.getNextWakeTime();
    assert(next !== undefined);
    expect(next % MINUTE).toBe(0);
    expect(next).toBeGreaterThan(Date.parse(stored));
    expect(next - Date.parse(stored)).toBeLessThanOrEqual(MINUTE);
    await harness.close();

    // A later process counts from the same place, not from its own start.
    const later = everyMinute(storage, []);
    await later.start();
    expect(await storage.get<string>(CURSOR_KEY)).toBe(stored);
    await later.close();
  });

  it('is undefined with nothing scheduled and nothing parked', async () => {
    const harness = new AgentHarness({
      name: 'schedule',
      params: {},
      agentGraph: agent,
      environment: {
        storage: {
          adapter: createInMemoryStorage(),
        },
      },
    });
    await harness.start();
    expect(await harness.getNextWakeTime()).toBeUndefined();
    await harness.close();
  });

  it('reads the schedule of any source that declares one', async () => {
    const storage = createInMemoryStorage();
    const batches = defineSource({
      events: {
        ready: z.object({}),
      },
      schedule: {
        next: (cursor) => (cursor === null ? undefined : Number(cursor) + 500),
        begin: () => '1000',
      },
    });
    const harness = new AgentHarness({
      name: 'schedule',
      params: {},
      agentGraph: agent,
      connections: {
        batches,
      },
      triggerTurnOn: [
        {
          id: 'on-batch',
          connection: 'batches',
          event: 'ready',
          input: '"go"',
        },
      ],
      environment: {
        storage: {
          adapter: storage,
        },
      },
    });
    await harness.start();
    expect(await harness.getNextWakeTime()).toBe(1500);
    await harness.close();
  });
});

describe('a cron trigger that was not running when its ticks fell due', () => {
  it('delivers them on start, and idle() waits for their turns', async () => {
    const storage = createInMemoryStorage();
    // The last tick this trigger saw was three minutes ago: two are overdue.
    const seen = minuteAgo(2);
    await storage.set(CURSOR_KEY, new Date(seen).toISOString());
    const ticks: string[] = [];
    const harness = everyMinute(storage, ticks);

    await harness.start();
    const due = await harness.getNextWakeTime();
    assert(due !== undefined);
    expect(due).toBeLessThanOrEqual(Date.now());

    await harness.waitForIdle();
    // The clock is real, so a minute may turn over mid-test and add a tick.
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks[0]).toContain(new Date(seen + MINUTE).toISOString());
    expect(ticks[1]).toContain(new Date(seen + 2 * MINUTE).toISOString());

    // Nothing is overdue now: the next tick is the one after the last delivered.
    const next = await harness.getNextWakeTime();
    assert(next !== undefined);
    expect(next).toBe(seen + (ticks.length + 1) * MINUTE);
    await harness.close();
  });

  it('idle() resolves at once when nothing is due or running', async () => {
    const harness = everyMinute(createInMemoryStorage(), []);
    await harness.start();
    const began = Date.now();
    await harness.waitForIdle();
    expect(Date.now() - began).toBeLessThan(500);
    await harness.close();
  });
});

describe('harness.onWakeTimeChange()', () => {
  it('hears the next tick when the harness starts, and each tick as it is read', async () => {
    const storage = createInMemoryStorage();
    // One tick is overdue, so starting reads it and the next wake time moves on.
    const seen = minuteAgo(1);
    await storage.set(CURSOR_KEY, new Date(seen).toISOString());
    const harness = everyMinute(storage, []);
    const heard: Array<number | undefined> = [];
    harness.onWakeTimeChange((at) => {
      heard.push(at);
    });

    await harness.start();
    await harness.waitForIdle();

    expect(heard.length).toBeGreaterThanOrEqual(1);
    expect(heard.at(-1)).toBe(await harness.getNextWakeTime());
    // Told of a change only: no time is heard twice running.
    for (const [index, at] of heard.entries()) {
      expect(at).not.toBe(heard[index - 1] ?? Number.NaN);
    }
    await harness.close();
  });

  it('hears undefined once the scheduled trigger is removed, and nothing after it is stopped', async () => {
    const harness = everyMinute(createInMemoryStorage(), []);
    const heard: Array<number | undefined> = [];
    const stop = harness.onWakeTimeChange((at) => {
      heard.push(at);
    });
    await harness.start();
    expect(heard).toHaveLength(1);

    expect(await harness.removeTrigger('every-minute')).toBe(true);
    expect(heard.at(-1)).toBeUndefined();
    expect(heard).toHaveLength(2);

    stop();
    await harness.addTrigger({
      id: 'again',
      connection: 'clock',
      event: 'tick',
      input: '"go"',
    });
    expect(heard).toHaveLength(2);
    await harness.close();
  });

  it('a listener that throws outside a parking turn is logged, not thrown', async () => {
    const harness = everyMinute(createInMemoryStorage(), []);
    await harness.start();
    harness.onWakeTimeChange(() => {
      throw new Error('no alarm');
    });
    expect(await harness.removeTrigger('every-minute')).toBe(true);
    await harness.close();
  });
});

describe('waitForIdle() and a tick that is being taken in', () => {
  it('waits for the turn of a tick whose wake-time listener is slow', async () => {
    // Regression: between storing a tick and starting its turn, the runner tells
    // the wake-time listeners. With a listener that takes time (setting an alarm
    // is a storage write), idle saw no turn yet and returned.
    const storage = createInMemoryStorage();
    await storage.set(CURSOR_KEY, new Date(minuteAgo(1)).toISOString());
    const ticks: string[] = [];
    const harness = everyMinute(storage, ticks);
    harness.onWakeTimeChange(() => new Promise((resolve) => setTimeout(resolve, 60)));

    await harness.start();
    await harness.waitForIdle();
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    await harness.close();
  });
});

describe('two triggers on one cron()', () => {
  it('each gets the ticks it missed, whichever of them was further behind', async () => {
    const storage = createInMemoryStorage();
    const cursorKey = (id: string): string => `noetic/connections/triggers/${id}/cursor`;
    // Listed first, and up to date but for one tick. The second missed three.
    await storage.set(cursorKey('recent'), new Date(minuteAgo(1)).toISOString());
    await storage.set(cursorKey('behind'), new Date(minuteAgo(3)).toISOString());
    const turns: string[] = [];
    const harness = new AgentHarness({
      name: 'schedule',
      params: {},
      agentGraph: agent,
      connections: {
        clock: cron('* * * * *'),
      },
      triggerTurnOn: [
        'recent',
        'behind',
      ].map((id) => ({
        id,
        connection: 'clock',
        event: 'tick',
        input: `"${id} " & event.payload.scheduledFor`,
        thread: `"${id}:" & event.id`,
      })),
      environment: {
        storage: {
          adapter: storage,
        },
      },
      _testCallModel: async (request) => {
        turns.push(JSON.stringify(request));
        return {
          items: [
            assistantMessage('done'),
          ],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    });
    await harness.start();
    const started = Date.now();
    await harness.waitForIdle();
    // It did not sit out the wait for an event that was never coming.
    expect(Date.now() - started).toBeLessThan(5e3);
    const of = (id: string): number => turns.filter((turn) => turn.includes(`${id} 20`)).length;
    expect(of('recent')).toBeGreaterThanOrEqual(1);
    expect(of('behind')).toBeGreaterThanOrEqual(3);
    // Nothing is left overdue, so a host's alarm is not set in the past.
    const next = await harness.getNextWakeTime();
    assert(next !== undefined);
    expect(next).toBeGreaterThan(Date.now() - 1e3);
    await harness.close();
  });
});

describe('a cron trigger that fell further behind than a restart replays', () => {
  it('starts again from now, and its next wake time is ahead', async () => {
    const storage = createInMemoryStorage();
    // Two days of minutes missed: more than the thousand a restart replays.
    await storage.set(CURSOR_KEY, new Date(minuteAgo(2 * 24 * 60)).toISOString());
    const ticks: string[] = [];
    const harness = everyMinute(storage, ticks);
    await harness.start();
    const next = await harness.getNextWakeTime();
    assert(next !== undefined);
    // The schedule agrees with the source: nothing is due that will not be delivered.
    expect(next).toBeGreaterThan(Date.now() - 1e3);
    await harness.waitForIdle();
    expect(ticks.length).toBeLessThan(3);
    await harness.close();
  });
});
