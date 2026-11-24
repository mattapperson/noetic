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

describe('harness.nextWake() with a cron trigger', () => {
  it('is the next tick, counted from a place the trigger stores when it first starts', async () => {
    const storage = createInMemoryStorage();
    const harness = everyMinute(storage, []);
    const before = Date.now();
    await harness.start();

    const stored = await storage.get<string>(CURSOR_KEY);
    assert(stored);
    expect(Date.parse(stored)).toBeGreaterThanOrEqual(before);

    const next = await harness.nextWake();
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
    expect(await harness.nextWake()).toBeUndefined();
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
    expect(await harness.nextWake()).toBe(1500);
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
    const due = await harness.nextWake();
    assert(due !== undefined);
    expect(due).toBeLessThanOrEqual(Date.now());

    await harness.idle();
    // The clock is real, so a minute may turn over mid-test and add a tick.
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks[0]).toContain(new Date(seen + MINUTE).toISOString());
    expect(ticks[1]).toContain(new Date(seen + 2 * MINUTE).toISOString());

    // Nothing is overdue now: the next tick is the one after the last delivered.
    const next = await harness.nextWake();
    assert(next !== undefined);
    expect(next).toBe(seen + (ticks.length + 1) * MINUTE);
    await harness.close();
  });

  it('idle() resolves at once when nothing is due or running', async () => {
    const harness = everyMinute(createInMemoryStorage(), []);
    await harness.start();
    const began = Date.now();
    await harness.idle();
    expect(Date.now() - began).toBeLessThan(500);
    await harness.close();
  });
});
