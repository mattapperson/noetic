// The two wake presets, each taking a parked turn across a killed Worker: a
// Durable Object alarm, and one Cloudflare Workflow instance per turn. See
// specs/25-platform-packages § Cloudflare Workers and specs/23-durable-execution
// § Parked turns.

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData, StorageAdapter } from '@noetic-tools/core';
import { AgentHarness, callModel, cron } from '@noetic-tools/core';
import { alarmWake } from '../src/alarm-wake';
import { createD1Storage } from '../src/d1-storage';
import { createDurableObjectStorage } from '../src/durable-object-storage';
import {
  DEFAULT_MAX_WAIT_MS,
  runTurn,
  startTurn,
  TURN_WAKE_EVENT,
  turnInstanceId,
  wakeTurn,
} from '../src/workflow-turn';
import type { Clock, Mailbox, Model } from './_helpers';
import {
  DAY,
  fakeAlarm,
  fakeBinding,
  fakeD1,
  fakeInstance,
  fakeObjectSql,
  HOUR,
  harnessOver,
  model,
} from './_helpers';

//#region Fixtures

interface World {
  storage: () => StorageAdapter;
  mailbox: Mailbox;
  clock: Clock;
  m: Model;
}

/** One database, and a fresh adapter over it for each Worker that comes up. */
const storages: Record<string, () => () => StorageAdapter> = {
  D1: () => {
    const db = new Database(':memory:');
    return () =>
      createD1Storage({
        database: fakeD1(db),
      });
  },
  'Durable Object SQL': () => {
    const db = new Database(':memory:');
    return () =>
      createDurableObjectStorage({
        sql: fakeObjectSql(db),
      });
  },
};

function world(storage: () => StorageAdapter): World {
  return {
    storage,
    mailbox: [],
    clock: {
      t: 1e6,
    },
    m: model('a'),
  };
}

/** A Worker coming up: a new harness over the same storage. */
function worker(w: World) {
  return harnessOver({
    storage: w.storage(),
    m: w.m,
    mailbox: w.mailbox,
    clock: w.clock,
  });
}

const thread = {
  threadId: 't',
};
const turn = {
  threadId: 't',
  messageId: 'm-1',
  input: 'hello',
};

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

//#endregion

for (const [name, make] of Object.entries(storages)) {
  describe(`woken by a Durable Object alarm, on ${name}`, () => {
    it('sets the alarm to the parked turn’s deadline, and clears it once nothing is parked', async () => {
      const w = world(make());
      const alarm = fakeAlarm();
      const first = worker(w);
      alarmWake({
        harness: first,
        alarms: alarm,
      });
      await first.start();
      expect(alarm.at).toBeUndefined();

      // The host sets nothing: the turn's alarm is there by the time it answers.
      await first.execute(turn.input, turn);
      const parked = await first.getAgentResponse(thread);
      assert(parked.parked);
      expect(alarm.at).toBe(1e6 + DAY);
      await first.close();
    });

    it('a turn whose alarm could not be set does not answer as parked', async () => {
      const w = world(make());
      const first = worker(w);
      alarmWake({
        harness: first,
        alarms: {
          setAlarm: () => {
            throw new Error('alarm refused');
          },
          deleteAlarm: () => undefined,
        },
      });
      await first.execute(turn.input, turn);
      await expect(first.getAgentResponse(thread)).rejects.toThrow('alarm refused');
      await first.close();
    });

    it('stops setting the alarm once stopped', async () => {
      const w = world(make());
      const alarm = fakeAlarm();
      const first = worker(w);
      alarmWake({
        harness: first,
        alarms: alarm,
      }).stop();
      await first.execute(turn.input, turn);
      assert((await first.getAgentResponse(thread)).parked);
      expect(alarm.at).toBeUndefined();
      await first.close();
    });

    it('a parked turn survives a killed Worker and a 16-hour jump; no model call is made twice', async () => {
      const w = world(make());
      const alarm = fakeAlarm();
      const first = worker(w);
      alarmWake({
        harness: first,
        alarms: alarm,
      });
      await first.execute(turn.input, turn);
      assert((await first.getAgentResponse(thread)).parked);
      expect(alarm.at).toBe(1e6 + DAY);
      await first.close();
      expect(w.m.calls).toBe(1);

      // Sixteen hours on, an alarm that fired early finds nothing due and re-arms.
      w.clock.t += 16 * HOUR;
      const early = worker(w);
      const earlyWake = alarmWake({
        harness: early,
        alarms: alarm,
        now: () => w.clock.t,
      });
      expect(await earlyWake.alarm()).toEqual([]);
      expect(alarm.at).toBe(1e6 + DAY);
      expect(w.m.calls).toBe(1);
      await early.close();

      // The reply came in; the alarm fires at the deadline in a new Worker.
      w.mailbox.push('approved');
      w.clock.t = 1e6 + DAY;
      const second = worker(w);
      const wake = alarmWake({
        harness: second,
        alarms: alarm,
        now: () => w.clock.t,
      });
      expect(await wake.alarm()).toEqual([
        't',
      ]);
      // `alarm()` stayed until the turn was over, and nothing is parked now.
      const response = await second.getAgentResponse(thread);
      expect(response.parked).toBeUndefined();
      expect(response.text).toBe('a-2');
      expect(w.m.calls).toBe(2);
      expect(alarm.at).toBeUndefined();
      await second.close();
    });
  });

  describe(`driven by a Cloudflare Workflow, on ${name}`, () => {
    it('runs the turn, sleeps to its deadline, and finishes when woken; a replayed instance repeats nothing', async () => {
      const w = world(make());
      const instance = fakeInstance();
      const first = worker(w);
      // The Workflow starts: the turn runs until it parks, then the instance sleeps.
      void runTurn({
        harness: first,
        step: instance.step(),
        turn,
        now: () => w.clock.t,
      }).catch(() => {});
      await settled();
      expect(instance.ran).toEqual([
        'turn-0',
      ]);
      expect(instance.waits).toEqual([
        {
          name: 'wait-1',
          timeout: DAY,
        },
      ]);
      expect(w.m.calls).toBe(1);
      await first.close();

      // The Worker is gone. The reply arrives and the host wakes the instance;
      // Workflows replays `run` from the top in a new Worker.
      w.mailbox.push('approved');
      w.clock.t += 16 * HOUR;
      instance.events += 1;
      const second = worker(w);
      const outcome = await runTurn({
        harness: second,
        step: instance.step(),
        turn,
        now: () => w.clock.t,
      });
      expect(outcome).toEqual({
        text: 'a-2',
      });
      // The first run was not made again: its step was on record.
      expect(instance.ran).toEqual([
        'turn-0',
        'turn-1',
      ]);
      expect(w.m.calls).toBe(2);
      await second.close();
    });
  });
}

describe('a turn’s Workflow instance', () => {
  it('goes round again when it is woken with nothing to do, and waits out the time left', async () => {
    const w = world(storages.D1?.() ?? expect.unreachable());
    const instance = fakeInstance();
    const harness = worker(w);
    const running = runTurn({
      harness,
      step: instance.step(),
      turn,
      now: () => w.clock.t,
    });
    await settled();

    // Woken early: the reply is not there, so the turn parks again.
    w.clock.t += 6 * HOUR;
    instance.send();
    await settled();
    expect(instance.ran).toEqual([
      'turn-0',
      'turn-1',
    ]);
    expect(instance.waits[1]).toEqual({
      name: 'wait-2',
      timeout: 18 * HOUR,
    });
    expect(w.m.calls).toBe(1);

    w.mailbox.push('approved');
    instance.send();
    expect(await running).toEqual({
      text: 'a-2',
    });
    await harness.close();
  });

  it('ends as gone when the turn is no longer there to wake', async () => {
    const w = world(storages.D1?.() ?? expect.unreachable());
    const instance = fakeInstance();
    const harness = worker(w);
    const running = runTurn({
      harness,
      step: instance.step(),
      turn,
      now: () => w.clock.t,
    });
    await settled();

    // Something else finished the turn first: the reply came and another Worker woke it.
    w.mailbox.push('approved');
    const other = worker(w);
    expect(await other.wake(thread)).toEqual([
      't',
    ]);
    expect((await other.getAgentResponse(thread)).text).toBe('a-2');
    await other.close();

    // The instance's deadline comes and it finds no turn to wake.
    instance.expire();
    expect(await running).toEqual({
      text: '',
      gone: true,
    });
    expect(w.m.calls).toBe(2);
    await harness.close();
  });
});

describe('waiting with no deadline', () => {
  const step = (run: {
    text: string;
    parked?: {
      wakeAt?: number;
    };
  }) => {
    const instance = fakeInstance();
    instance.done.set('turn-0', run);
    return instance;
  };
  const gone = {
    execute: async () => {},
    wake: async () => [],
    getAgentResponse: () => expect.unreachable(),
    getStatus: () => ({
      kind: 'idle' as const,
    }),
  };

  it('sleeps `maxWaitMs`, a day by default', async () => {
    const instance = step({
      text: '',
      parked: {},
    });
    instance.events = 1;
    await runTurn({
      harness: gone,
      step: instance.step(),
      turn,
    });
    expect(instance.waits[0]?.timeout).toBe(DEFAULT_MAX_WAIT_MS);
  });

  it('never sleeps past `maxWaitMs`, nor for less than a second', async () => {
    const far = step({
      text: '',
      parked: {
        wakeAt: 1e6 + 30 * DAY,
      },
    });
    far.events = 1;
    await runTurn({
      harness: gone,
      step: far.step(),
      turn,
      maxWaitMs: HOUR,
      now: () => 1e6,
    });
    expect(far.waits[0]?.timeout).toBe(HOUR);

    const due = step({
      text: '',
      parked: {
        wakeAt: 1e6 - 5,
      },
    });
    due.events = 1;
    const outcome = await runTurn({
      harness: gone,
      step: due.step(),
      turn,
      now: () => 1e6,
    });
    expect(due.waits[0]?.timeout).toBe(1e3);
    expect(outcome).toEqual({
      text: '',
      gone: true,
    });
  });
});

describe('starting and waking a turn’s instance', () => {
  it('a message delivered twice starts one instance', async () => {
    const binding = fakeBinding();
    const id = await startTurn(binding, turn);
    expect(await startTurn(binding, turn)).toBe(id);
    expect(id.startsWith('t-m-1_')).toBe(true);
    expect([
      ...binding.created.keys(),
    ]).toEqual([
      id,
    ]);
  });

  it('passes on a create failure that is not “already exists”', async () => {
    const binding = fakeBinding();
    binding.create = async () => {
      throw new Error('rate limited');
    };
    await expect(startTurn(binding, turn)).rejects.toThrow('rate limited');
  });

  it('wakes an instance with the wake event', async () => {
    const binding = fakeBinding();
    const id = await startTurn(binding, turn);
    await wakeTurn(binding, id);
    expect(binding.sent).toEqual([
      {
        id,
        type: TURN_WAKE_EVENT,
      },
    ]);
    await expect(wakeTurn(binding, 'nobody')).rejects.toThrow('instance.not_found');
  });

  it('makes ids Workflows accepts, and different turns never share one', async () => {
    const VALID = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;
    const slack = await turnInstanceId('slack:C01/1700.5', 'evt.9');
    expect(slack).toMatch(VALID);
    // Two ids that differ only in a replaced character stay apart.
    expect(await turnInstanceId('slack:C01_1700.5', 'evt.9')).not.toBe(slack);
    expect(await turnInstanceId('slack:C01/1700.5', 'evt.9')).toBe(slack);

    const long = await turnInstanceId('t'.repeat(150), 'm-1');
    expect(long).toHaveLength(100);
    expect(long).toMatch(VALID);
    expect(await turnInstanceId('t'.repeat(150), 'm-2')).not.toBe(long);

    // Never longer than Workflows allows, however the two ids add up.
    expect((await turnInstanceId('a'.repeat(96), 'm-1')).length).toBeLessThanOrEqual(100);
    expect(await turnInstanceId('a'.repeat(97), 'm-1')).toHaveLength(100);
    expect(await turnInstanceId('-lead', 'm')).toMatch(VALID);

    // Joined with a dash these two read the same. They are different turns.
    expect(await turnInstanceId('a-b', 'c')).not.toBe(await turnInstanceId('a', 'b-c'));
    expect(await turnInstanceId('a.b-c', 'd')).not.toBe(await turnInstanceId('a.b', 'c-d'));
  });
});

describe('a cron() trigger on the alarm preset', () => {
  const MINUTE = 6e4;
  const CURSOR_KEY = 'noetic/connections/triggers/every-minute/cursor';

  function everyMinute(storage: StorageAdapter, ticks: string[]): AgentHarness {
    return new AgentHarness({
      name: 'worker',
      params: {},
      agentGraph: callModel<ContextData, string, string>({
        id: 'agent',
        model: 'test/model',
      }),
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
          park: {
            graceMs: 0,
            autoWake: false,
          },
        },
      },
      _testCallModel: async (request) => {
        ticks.push(JSON.stringify(request));
        return model('tick').call(request);
      },
    });
  }

  it('sets the first alarm to the next tick', async () => {
    const storage = (storages.D1?.() ?? expect.unreachable())();
    const alarm = fakeAlarm();
    const harness = everyMinute(storage, []);
    alarmWake({
      harness,
      alarms: alarm,
    });
    // Starting the harness is all a new object does.
    await harness.start();
    assert(alarm.at !== undefined);
    expect(alarm.at % MINUTE).toBe(0);
    expect(alarm.at).toBeGreaterThan(Date.now());
    expect(alarm.at - Date.now()).toBeLessThanOrEqual(MINUTE);
    await harness.close();
  });

  it('runs the tick that fell due while no Worker was up, then sets the next alarm', async () => {
    const make = storages.D1?.() ?? expect.unreachable();
    // The object last saw the tick a minute ago; the alarm for this one fires now.
    const thisTick = Math.floor(Date.now() / MINUTE) * MINUTE;
    await make().set(CURSOR_KEY, new Date(thisTick - MINUTE).toISOString());

    const ticks: string[] = [];
    const alarm = fakeAlarm();
    const harness = everyMinute(make(), ticks);
    await alarmWake({
      harness,
      alarms: alarm,
    }).alarm();

    // `alarm()` stayed until the tick's turn was over.
    // The clock is real, so a minute may turn over mid-test and add a tick.
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0]).toContain(new Date(thisTick).toISOString());
    expect(alarm.at).toBe(thisTick + ticks.length * MINUTE);
    await harness.close();
  });
});

describe('a turn another Worker still holds', () => {
  it('is not reported gone by the Workflows preset: the step fails, to be retried', async () => {
    const make = storages.D1?.() ?? expect.unreachable();
    const w = world(make);
    const instance = fakeInstance();
    const first = worker(w);
    void runTurn({
      harness: first,
      step: instance.step(),
      turn,
      now: () => w.clock.t,
    }).catch(() => {});
    await settled();
    await first.close();

    // A Worker that was resuming the turn died: its lease has time left to run.
    await make().set('turn-lease:t', {
      term: 9,
      holder: 'a-worker-that-died',
      heldUntil: w.clock.t + 3e4,
    });
    w.mailbox.push('approved');
    instance.events += 1;
    const second = worker(w);
    const outcome = await runTurn({
      harness: second,
      step: instance.step(),
      turn,
      now: () => w.clock.t,
    }).then(
      (done) => done,
      () => 'step failed',
    );
    // Not "gone": the turn is there. Workflows retries a step that threw.
    expect(outcome).toBe('step failed');
    expect(
      await make().get<{
        turn?: object;
      }>('session:t'),
    ).toMatchObject({
      turn: {},
    });
    await second.close();
  });

  it("keeps the alarm set, for when the dead Worker's lease runs out", async () => {
    const make = storages.D1?.() ?? expect.unreachable();
    const w = world(make);
    const first = worker(w);
    await first.execute(turn.input, turn);
    assert((await first.getAgentResponse(thread)).parked);
    await first.close();

    // The turn was woken and then cut off: no park on record, a live lease.
    const stored = await make().get<{
      turn: {
        parked?: object;
      };
    }>('session:t');
    assert(stored);
    const { parked: _parked, ...cutOff } = stored.turn;
    await make().set('session:t', {
      ...stored,
      turn: cutOff,
    });
    await make().set('turn-lease:t', {
      term: 9,
      holder: 'a-worker-that-died',
      heldUntil: w.clock.t + 3e4,
    });

    const alarm = fakeAlarm();
    const second = worker(w);
    await alarmWake({
      harness: second,
      alarms: alarm,
      now: () => w.clock.t,
    }).alarm();
    // Nothing could be woken yet, and the alarm is not dropped: it comes back
    // when the lease is free, not in a tight loop before then.
    expect(alarm.at).toBe(w.clock.t + 3e4);
    await second.close();
  });
});

describe('an alarm pass that leaves something due', () => {
  it('sets the next alarm ahead, never in the past where it would fire at once', async () => {
    const alarm = fakeAlarm();
    const clock = {
      t: 5e6,
    };
    // Due an hour ago, and no pass changes that: a schedule whose source will not deliver.
    const stuck: Parameters<typeof alarmWake>[0]['harness'] = {
      start: async () => {},
      wake: async () => [],
      waitForIdle: async () => {},
      getNextWakeTime: async () => clock.t - HOUR,
      onWakeTimeChange: () => () => {},
    };
    await alarmWake({
      harness: stuck,
      alarms: alarm,
      now: () => clock.t,
    }).alarm();
    assert(alarm.at !== undefined);
    expect(alarm.at).toBeGreaterThan(clock.t);
    // Soon enough to pick the work up when it can be done.
    expect(alarm.at).toBeLessThanOrEqual(clock.t + 6e4);
  });
});
