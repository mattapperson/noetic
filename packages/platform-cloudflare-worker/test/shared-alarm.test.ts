// One Durable Object alarm shared by the harness and the object's own work, the
// object's id as the lease holder, and a cut turn brought back by the alarm. See
// specs/25-platform-packages § Waking parked turns and specs/23-durable-execution
// § Cut turns.

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData, HarnessResponse, StorageAdapter } from '@noetic-tools/core';
import { AgentHarness, callModel } from '@noetic-tools/core';
import type { SharedAlarmStorageLike } from '../src/alarm-wake';
import { alarmWake, durableObjectHolder, sharedAlarm } from '../src/alarm-wake';
import { createDurableObjectStorage } from '../src/durable-object-storage';
import type { TurnHarness } from '../src/workflow-turn';
import { runTurn } from '../src/workflow-turn';
import type { Clock } from './_helpers';
import { DAY, fakeInstance, fakeObjectSql, harnessOver, model } from './_helpers';

//#region Fixtures

interface FakeObjectAlarm extends SharedAlarmStorageLike {
  at: number | null;
  sets: number[];
}

function objectAlarm(): FakeObjectAlarm {
  const alarm: FakeObjectAlarm = {
    at: null,
    sets: [],
    getAlarm: () => alarm.at,
    setAlarm: (at) => {
      alarm.at = at;
      alarm.sets.push(at);
    },
    deleteAlarm: () => {
      alarm.at = null;
    },
  };
  return alarm;
}

/** Durable Object storage whose ledger writes throw while `failing` is set. */
interface FlakyStorage extends StorageAdapter {
  failing: boolean;
}

function flakyObjectStorage(db: Database): FlakyStorage {
  const inner = createDurableObjectStorage({
    sql: fakeObjectSql(db),
  });
  const swap = inner.swap?.bind(inner);
  assert(swap);
  const refuse = (key: string): void => {
    if (storage.failing && key.includes(':ledger:')) {
      throw new Error('D1 unavailable');
    }
  };
  const storage: FlakyStorage = {
    failing: false,
    get: (key) => inner.get(key),
    set: async (key, value) => {
      refuse(key);
      await inner.set(key, value);
    },
    delete: (key) => inner.delete(key),
    list: (prefix) => inner.list(prefix),
    swap: async (key, prev, next) => {
      refuse(key);
      return swap(key, prev, next);
    },
  };
  return storage;
}

const OBJECT = {
  id: {
    toString: () => 'object-1',
  },
};

function objectHarness(storage: StorageAdapter, clock: Clock): AgentHarness {
  return new AgentHarness({
    name: 'object',
    params: {},
    agentGraph: callModel<ContextData, string, string>({
      id: 'respond',
      model: 'test/model',
    }),
    now: () => clock.t,
    environment: {
      storage: {
        adapter: storage,
        lease: {
          holder: durableObjectHolder(OBJECT),
          waitMs: 0,
        },
        park: {
          autoWake: false,
        },
      },
    },
    _testCallModel: model('a').call,
  });
}

const thread = {
  threadId: 't',
};

//#endregion

describe('sharedAlarm', () => {
  it('outside the handler only brings the alarm forward', async () => {
    const alarm = objectAlarm();
    alarm.at = 500;
    const shared = sharedAlarm(alarm);
    await shared.schedule('retries')(900);
    expect(alarm.at).toBe(500);
    await shared.schedule('noetic')(300);
    expect(alarm.at).toBe(300);
    // Asking for none, or later, leaves a stored alarm another part may still need.
    await shared.schedule('noetic')(undefined);
    expect(alarm.at).toBe(300);
    expect(shared.wantedAt()).toBe(900);
  });

  it('sets an alarm where none is stored', async () => {
    const alarm = objectAlarm();
    const shared = sharedAlarm(alarm);
    await shared.schedule('retries')(900);
    expect(alarm.at).toBe(900);
  });

  it('in the handler forgets the times that came, and sets the earliest one said again', async () => {
    const alarm = objectAlarm();
    let now = 0;
    const shared = sharedAlarm(alarm, {
      now: () => now,
    });
    const noetic = shared.schedule('noetic');
    const retries = shared.schedule('retries');
    await noetic(100);
    await retries(5e3);
    now = 100;
    const setsBefore = alarm.sets.length;
    await shared.alarm(async () => {
      // A part whose time came and that says nothing more is forgotten.
      await retries(2e3);
    });
    // Set once, when the handler is done.
    expect(alarm.sets.length).toBe(setsBefore + 1);
    expect(alarm.at).toBe(2e3);
    expect(shared.wantedAt()).toBe(2e3);

    now = 2e3;
    await shared.alarm(async () => {});
    expect(alarm.at).toBeNull();
  });

  it('keeps the time of a part that has not come yet', async () => {
    const alarm = objectAlarm();
    let now = 0;
    const shared = sharedAlarm(alarm, {
      now: () => now,
    });
    await shared.schedule('noetic')(100);
    await shared.schedule('sweep')(9e3);
    now = 100;
    await shared.alarm(async () => {});
    expect(alarm.at).toBe(9e3);
  });

  it('leaves the alarm set when the handler throws, and lets the throw through', async () => {
    const alarm = objectAlarm();
    let now = 0;
    const shared = sharedAlarm(alarm, {
      now: () => now,
    });
    const retries = shared.schedule('retries');
    await retries(10);
    now = 10;
    await expect(
      shared.alarm(async () => {
        await retries(60);
        throw new Error('write failed');
      }),
    ).rejects.toThrow('write failed');
    expect(alarm.at).toBe(60);
  });
});

describe('sharedAlarm under concurrency and failure', () => {
  it('two parts asking at once leave the alarm at the earlier time', async () => {
    const box: {
      at: number | null;
    } = {
      at: null,
    };
    const slow: SharedAlarmStorageLike = {
      getAlarm: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return box.at;
      },
      setAlarm: async (at) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        box.at = at;
      },
      deleteAlarm: () => {
        box.at = null;
      },
    };
    const shared = sharedAlarm(slow);
    await Promise.all([
      shared.schedule('late')(900),
      shared.schedule('soon')(100),
    ]);
    expect(box.at).toBe(100);
  });

  it('a handler’s error is the one thrown when setting the alarm fails too', async () => {
    const shared = sharedAlarm({
      getAlarm: () => null,
      setAlarm: () => {
        throw new Error('alarm refused');
      },
      deleteAlarm: () => {
        throw new Error('alarm refused');
      },
    });
    await expect(
      shared.alarm(async () => {
        throw new Error('write failed');
      }),
    ).rejects.toThrow('write failed');
    await expect(shared.alarm(async () => {})).rejects.toThrow('alarm refused');
  });
});

describe('alarmWake with a schedule', () => {
  it('says the parked turn’s deadline to the schedule and sets no alarm itself', async () => {
    const clock: Clock = {
      t: 1e6,
    };
    const alarm = objectAlarm();
    const shared = sharedAlarm(alarm, {
      now: () => clock.t,
    });
    const harness = harnessOver({
      storage: createDurableObjectStorage({
        sql: fakeObjectSql(),
      }),
      m: model('a'),
      mailbox: [],
      clock,
    });
    const said: Array<number | undefined> = [];
    const wake = alarmWake({
      harness,
      schedule: async (at) => {
        said.push(at);
        await shared.schedule('noetic')(at);
      },
      now: () => clock.t,
    });
    await shared.schedule('sweep')(clock.t + 60e3);
    await harness.execute('hello', {
      threadId: 't',
      messageId: 'm-1',
    });
    assert((await harness.getAgentResponse(thread)).parked);
    expect(wake.wantedAt()).toBe(clock.t + DAY);
    expect(said.at(-1)).toBe(clock.t + DAY);
    // While the turn ran, the harness asked for an alarm one lease period ahead, in
    // case the isolate died. Outside the handler a later time never moves the alarm
    // back, so that early one stands; it does no harm.
    const early = alarm.at;
    assert(early !== null);
    expect(early).toBeLessThan(1e6 + 60e3);

    // It fires: nothing of noetic's is due, and the sweep's time has not come.
    clock.t = early;
    await shared.alarm(async () => {
      expect(await wake.alarm()).toEqual([]);
    });
    expect(alarm.at).toBe(1e6 + 60e3);

    // The sweep runs and wants nothing more: the alarm moves to the turn's deadline.
    clock.t = 1e6 + 60e3;
    await shared.alarm(async () => {
      await wake.alarm();
      await shared.schedule('sweep')(undefined);
    });
    expect(alarm.at).toBe(1e6 + DAY);
    await harness.close();
  });
});

describe('durableObjectHolder', () => {
  it('names the lease holder after the object', () => {
    expect(durableObjectHolder(OBJECT)).toBe('object-1');
  });
});

describe('a cut turn in a Durable Object', () => {
  it('answers cut, and the alarm brings it back after its back-off, in a new isolate', async () => {
    const db = new Database(':memory:');
    const clock: Clock = {
      t: 1e6,
    };
    const alarm = objectAlarm();
    const storage = flakyObjectStorage(db);
    const first = objectHarness(storage, clock);
    alarmWake({
      harness: first,
      schedule: sharedAlarm(alarm, {
        now: () => clock.t,
      }).schedule('noetic'),
      now: () => clock.t,
    });
    await first.start();
    storage.failing = true;
    await first.execute('hello', {
      threadId: 't',
      messageId: 'm-1',
    });
    const cut = (await first.getAgentResponse(thread)).cut;
    assert(cut);
    expect(cut.reason).toBe('ledger_write_failed');
    // The alarm is set before the turn answers as cut.
    expect(alarm.at).toBe(cut.wakeAt);
    storage.failing = false;
    await first.close();

    // The isolate is gone. The object comes back and its alarm fires.
    clock.t = cut.wakeAt;
    const shared = sharedAlarm(alarm, {
      now: () => clock.t,
    });
    const second = objectHarness(flakyObjectStorage(db), clock);
    const wake = alarmWake({
      harness: second,
      schedule: shared.schedule('noetic'),
      now: () => clock.t,
    });
    let woken: string[] = [];
    await shared.alarm(async () => {
      woken = await wake.alarm();
    });
    expect(woken).toEqual([
      't',
    ]);
    const response = await second.getAgentResponse(thread);
    expect(response.cut).toBeUndefined();
    expect(response.text).toBe('a-1');
    expect(alarm.at).toBeNull();
    await second.close();
  });
});

describe('runTurn after the turn was taken by another harness', () => {
  it('waits out the other lease, then delivers the message again for its answer', async () => {
    const instance = fakeInstance();
    const delivered: string[] = [];
    const answers: HarnessResponse[] = [
      {
        items: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
        text: '',
        cut: {
          reason: 'lease_lost',
          wakeAt: 5e3,
        },
      },
      {
        items: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
        text: 'answered by the other harness',
        replayed: true,
      },
    ];
    const harness: TurnHarness = {
      execute: async (_input, options) => {
        delivered.push(String(options?.messageId));
      },
      // The other harness finished the turn: nothing is left to wake.
      wake: async () => [],
      getStatus: () => ({
        kind: 'idle',
      }),
      getAgentResponse: async () => {
        const next = answers.shift();
        assert(next);
        return next;
      },
    };
    const outcome = runTurn({
      harness,
      step: instance.step(),
      turn: {
        threadId: 't',
        messageId: 'm-1',
        input: 'hello',
      },
      now: () => 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(instance.waits[0]?.timeout).toBe(5e3);
    instance.expire();
    expect(await outcome).toEqual({
      text: 'answered by the other harness',
    });
    expect(delivered).toEqual([
      'm-1',
      'm-1',
    ]);
  });
});
