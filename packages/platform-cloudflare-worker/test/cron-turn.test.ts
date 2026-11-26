// Cron Trigger ticks as turns of the harness a Durable Object owns: one harness for
// requests, alarms and ticks, a tick that runs once, and a turn the object was
// evicted in. See specs/25-platform-packages § Cron Triggers.

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import type { CallModelRequest, ContextData, LLMResponse } from '@noetic-tools/core';
import { AgentHarness, callModel } from '@noetic-tools/core';
import type { AlarmWake, CronTick } from '../src';
import { alarmWake, cronTurn, durableObjectEnvironment } from '../src';
import type { FakeAlarm, Model } from './_helpers';
import { fakeAlarm, fakeObjectSql, model } from './_helpers';

//#region Fixtures

const CRON = '0 8 * * *';

const tickAt = (scheduledTime: number): CronTick => ({
  cron: CRON,
  scheduledTime,
});

const digestThread = {
  threadId: 'cron:digest',
};

interface FakeObject {
  harness: AgentHarness;
  alarm: FakeAlarm;
  wake: AlarmWake;
  tick(tick: CronTick): Promise<void>;
}

/** A Durable Object's isolate over `db`: what the class builds in its fields. */
function objectOver(
  db: Database,
  call: (request: CallModelRequest) => Promise<LLMResponse>,
): FakeObject {
  const harness = new AgentHarness({
    name: 'object',
    params: {},
    agentGraph: callModel<ContextData, string, string>({
      id: 'respond',
      model: 'test/model',
    }),
    environment: durableObjectEnvironment({
      id: {
        toString: () => 'object-1',
      },
      storage: {
        sql: fakeObjectSql(db),
      },
    }),
    _testCallModel: call,
  });
  const alarm = fakeAlarm();
  const wake = alarmWake({
    harness,
    alarms: alarm,
  });
  return {
    harness,
    alarm,
    wake,
    tick: cronTurn({
      cron: CRON,
      name: 'digest',
      harness,
      wake,
      input: (tick) => `digest for ${tick.scheduledTime}`,
    }),
  };
}

/** A model whose first call never answers: the isolate is gone before it does. */
function hanging(m: Model): (request: CallModelRequest) => Promise<LLMResponse> {
  return (request) => {
    m.calls += 1;
    return new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };
}

//#endregion

describe('durableObjectEnvironment', () => {
  it('is the object’s SQLite, its id as lease holder, and no timers of its own', async () => {
    const db = new Database(':memory:');
    const { storage } = durableObjectEnvironment(
      {
        id: {
          toString: () => 'object-1',
        },
        storage: {
          sql: fakeObjectSql(db),
        },
      },
      {
        table: 'agent',
      },
    );
    expect(storage.lease).toEqual({
      holder: 'object-1',
    });
    expect(storage.park).toEqual({
      autoWake: false,
    });
    await storage.adapter?.set('k', 1);
    expect(db.query('SELECT key FROM agent').all()).toEqual([
      {
        key: 'k',
      },
    ]);
  });
});

describe('cronTurn', () => {
  it('runs a tick on the harness the object’s requests use', async () => {
    const m = model('a');
    const object = objectOver(new Database(':memory:'), m.call);
    await object.harness.execute('hello', {
      threadId: 'main',
      messageId: 'm-1',
    });
    await object.tick(tickAt(6e4));
    expect(
      (
        await object.harness.getAgentResponse({
          threadId: 'main',
        })
      ).text,
    ).toBe('a-1');
    const digest = await object.harness.getAgentResponse(digestThread);
    expect(digest.text).toBe('a-2');
    expect(JSON.stringify(digest.items)).toContain('digest for 60000');
    await object.harness.close();
  });

  it('ignores another schedule’s tick', async () => {
    const m = model('a');
    const object = objectOver(new Database(':memory:'), m.call);
    await object.tick({
      cron: '* * * * *',
      scheduledTime: 6e4,
    });
    expect(m.calls).toBe(0);
    expect(await object.harness.getStoredThread('cron:digest')).toBeUndefined();
    await object.harness.close();
  });

  it('runs a tick delivered twice, at once or later, as one turn', async () => {
    const m = model('a');
    const object = objectOver(new Database(':memory:'), m.call);
    await Promise.all([
      object.tick(tickAt(6e4)),
      object.tick(tickAt(6e4)),
    ]);
    await object.tick(tickAt(6e4));
    expect(m.calls).toBe(1);
    const again = await object.harness.getAgentResponse(digestThread);
    expect(again.replayed).toBe(true);
    expect(again.text).toBe('a-1');

    // The next tick is a new message on the same thread.
    await object.tick(tickAt(12e4));
    expect(m.calls).toBe(2);
    expect((await object.harness.getAgentResponse(digestThread)).text).toBe('a-2');
    await object.harness.close();
  });

  it('answers a finished tick from the record in a new isolate', async () => {
    const db = new Database(':memory:');
    const first = objectOver(db, model('a').call);
    await first.tick(tickAt(6e4));
    await first.harness.close();

    const m = model('b');
    const second = objectOver(db, m.call);
    await second.tick(tickAt(6e4));
    expect(m.calls).toBe(0);
    const again = await second.harness.getAgentResponse(digestThread);
    expect(again.replayed).toBe(true);
    expect(again.text).toBe('a-1');
    await second.harness.close();
  });

  it('finishes the turn the object was evicted in before the next tick’s', async () => {
    const db = new Database(':memory:');
    const lost = model('lost');
    const first = objectOver(db, hanging(lost));
    void first.tick(tickAt(6e4));
    while (lost.calls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // The turn asked for an alarm, in case the isolate died while it ran.
    expect(first.alarm.at).toBeGreaterThan(Date.now());

    // The isolate is gone. The object comes back for the next tick.
    const m = model('b');
    const second = objectOver(db, m.call);
    await second.tick(tickAt(12e4));
    expect(m.calls).toBe(2);
    const response = await second.harness.getAgentResponse(digestThread);
    expect(response.text).toBe('b-2');
    const history = JSON.stringify(response.items);
    expect(history).toContain('digest for 60000');
    expect(history).toContain('b-1');
    expect(history).toContain('digest for 120000');
    expect(second.alarm.at).toBeUndefined();
    await second.harness.close();
    await first.harness.close();
  });

  it('finishes the evicted turn when the same tick comes again', async () => {
    const db = new Database(':memory:');
    const lost = model('lost');
    const first = objectOver(db, hanging(lost));
    void first.tick(tickAt(6e4));
    while (lost.calls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const m = model('b');
    const second = objectOver(db, m.call);
    await second.tick(tickAt(6e4));
    expect(m.calls).toBe(1);
    expect((await second.harness.getAgentResponse(digestThread)).text).toBe('b-1');
    await second.harness.close();
    await first.harness.close();
  });

  it('does not throw for a turn that failed, and runs it again when its tick comes again', async () => {
    const m = model('a');
    let offline = true;
    const object = objectOver(new Database(':memory:'), async (request) => {
      if (offline) {
        throw new Error('model offline');
      }
      return m.call(request);
    });
    await object.tick(tickAt(6e4));
    await expect(object.harness.getAgentResponse(digestThread)).rejects.toThrow('model offline');
    // A failed turn is not the alarm's to run again.
    expect(object.alarm.at).toBeUndefined();

    offline = false;
    await object.tick(tickAt(6e4));
    expect(m.calls).toBe(1);
    expect((await object.harness.getAgentResponse(digestThread)).text).toBe('a-1');
    await object.harness.close();
  });

  it('starts the next tick afresh over a turn that failed', async () => {
    const m = model('a');
    let offline = true;
    const object = objectOver(new Database(':memory:'), async (request) => {
      if (offline) {
        throw new Error('model offline');
      }
      return m.call(request);
    });
    await object.tick(tickAt(6e4));
    offline = false;
    await object.tick(tickAt(12e4));
    expect(m.calls).toBe(1);
    const response = await object.harness.getAgentResponse(digestThread);
    expect(response.text).toBe('a-1');
    const history = JSON.stringify(response.items);
    expect(history).toContain('digest for 120000');
    expect(history).not.toContain('digest for 60000');
    await object.harness.close();
  });
});
