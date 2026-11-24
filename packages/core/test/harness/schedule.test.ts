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
    triggers: [
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
      triggers: [
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
