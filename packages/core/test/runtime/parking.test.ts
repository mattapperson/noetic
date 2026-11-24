// Parked turns: a turn whose every step is waiting stops holding a process, and
// `harness.wake()` resumes it. See specs/23-durable-execution § Parked turns.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { CallModelRequest, ContextData, Item, LLMResponse } from '@noetic-tools/types';
import { isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { callModel, runCode, step } from '../../src/builders/step-builders';
import { defineSource } from '../../src/connections/sources';
import { AgentHarness } from '../../src/harness/agent-harness';
import { Parking } from '../../src/runtime/durable/parking';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { assistantMessage } from '../_helpers';

//#region Fixtures

const HOUR = 36e5;
const DAY = 24 * HOUR;

interface Clock {
  t: number;
}

async function tick(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves once `parking` has called `onPark`, with what it was called with. */
function armed(parking: Parking): {
  parkedAt: number[];
} {
  const seen: {
    parkedAt: number[];
  } = {
    parkedAt: [],
  };
  parking.arm({
    graceMs: 0,
    onPark: (wakeAt) => {
      seen.parkedAt.push(wakeAt);
    },
  });
  return seen;
}

//#endregion

describe('Parking', () => {
  it('parks when the only step in flight is waiting, at its deadline', async () => {
    const parking = new Parking();
    const seen = armed(parking);
    parking.enter('/flow#0');
    parking.enter('/flow#0/wait#0');
    parking.wait('/flow#0/wait#0', 500);
    await tick();
    expect(seen.parkedAt).toEqual([
      500,
    ]);
    expect(parking.parkedUntil).toBe(500);
  });

  it('does not park while another branch is still working', async () => {
    const parking = new Parking();
    const seen = armed(parking);
    parking.enter('/fork#0');
    parking.enter('/fork#0[0]/wait#0');
    const leaveWork = parking.enter('/fork#0[1]/work#0');
    parking.wait('/fork#0[0]/wait#0', 500);
    await tick();
    expect(seen.parkedAt).toEqual([]);

    // The working branch finishes; only the wait is left.
    leaveWork();
    await tick();
    expect(seen.parkedAt).toEqual([
      500,
    ]);
  });

  it('wakes at the earliest deadline when several branches wait', async () => {
    const parking = new Parking();
    const seen = armed(parking);
    parking.enter('/fork#0');
    parking.enter('/fork#0[0]/wait#0');
    parking.enter('/fork#0[1]/wait#0');
    parking.wait('/fork#0[0]/wait#0', 900);
    parking.wait('/fork#0[1]/wait#0', 300);
    await tick();
    expect(seen.parkedAt).toEqual([
      300,
    ]);
  });

  it('does not park when the wait ends within the grace', async () => {
    const parking = new Parking();
    const seen: {
      parkedAt: number[];
    } = {
      parkedAt: [],
    };
    parking.arm({
      graceMs: 30,
      onPark: (wakeAt) => {
        seen.parkedAt.push(wakeAt);
      },
    });
    parking.enter('/wait#0');
    const stop = parking.wait('/wait#0', 500);
    stop();
    await tick(60);
    expect(seen.parkedAt).toEqual([]);
  });

  it('a parent between two children counts as working', async () => {
    const parking = new Parking();
    const seen = armed(parking);
    parking.enter('/flow#0');
    const leaveWait = parking.enter('/flow#0/wait#0');
    // The wait is over and the parent has not started its next step yet.
    leaveWait();
    await tick();
    expect(seen.parkedAt).toEqual([]);
  });

  it('a step with no path keeps the turn live', async () => {
    const parking = new Parking();
    const seen = armed(parking);
    parking.enter(undefined);
    parking.enter('/wait#0');
    parking.wait('/wait#0', 500);
    await tick();
    expect(seen.parkedAt).toEqual([]);
  });

  it('never parks unless armed', async () => {
    const parking = new Parking();
    parking.enter('/wait#0');
    parking.wait('/wait#0', 500);
    await tick();
    expect(parking.parkedUntil).toBeUndefined();
  });
});

describe('a parked turn', () => {
  interface Model {
    calls: number;
    call: (request: CallModelRequest) => Promise<LLMResponse>;
  }

  function model(tag: string): Model {
    const m: Model = {
      calls: 0,
      call: async () => {
        m.calls += 1;
        return {
          items: [
            assistantMessage(`${tag}-${m.calls}`),
          ],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };
    return m;
  }

  /** Replies that live outside any harness, as an upstream system's would. */
  type Mailbox = string[];

  /**
   * A source over `mailbox` that replays from a cursor: the index of the last reply
   * a listener saw. A new harness gets a new source over the same mailbox.
   */
  function inbox(mailbox: Mailbox) {
    return defineSource({
      events: {
        reply: z.object({
          text: z.string(),
        }),
      },
      async start({ emit, cursor, signal }) {
        let next = cursor === null ? 0 : Number(cursor) + 1;
        while (!signal.aborted) {
          const text = mailbox[next];
          if (text === undefined) {
            await tick(2);
            continue;
          }
          await emit({
            type: 'reply',
            id: `reply-${next}`,
            cursor: String(next),
            payload: {
              text,
            },
          });
          next += 1;
        }
      },
    });
  }

  const turn = (id: string) =>
    callModel<ContextData, string, string>({
      id,
      model: 'test/model',
    });

  const waitForReply = step.wait({
    id: 'wait',
    connection: 'inbox',
    event: 'reply',
    timeoutMs: DAY,
  });

  const WaitedSchema = z.object({
    event: z.object({
      payload: z.object({
        text: z.string(),
      }),
    }),
  });

  /** Plan, wait for a person's reply, then answer with it. */
  const flow = runCode<ContextData, string, string>({
    id: 'flow',
    execute: async (input, execCtx) => {
      await execCtx.harness.run(turn('plan'), input, execCtx);
      const waited = WaitedSchema.parse(
        await execCtx.harness.run(waitForReply, undefined, execCtx),
      );
      const reply = waited.event.payload;
      return String(await execCtx.harness.run(turn('answer'), reply.text, execCtx));
    },
  });

  function harnessOver(opts: {
    storage: StorageAdapter;
    m: Model;
    mailbox: Mailbox;
    clock: Clock;
    park?: boolean;
  }): AgentHarness {
    return new AgentHarness({
      name: 'parking',
      params: {},
      agentGraph: flow,
      now: () => opts.clock.t,
      connections: {
        inbox: inbox(opts.mailbox),
      },
      environment: {
        storage: {
          adapter: opts.storage,
          lease: {
            waitMs: 0,
          },
          park:
            opts.park === false
              ? false
              : {
                  graceMs: 0,
                },
        },
      },
      _testCallModel: (request) => opts.m.call(request),
    });
  }

  interface Fixture {
    storage: StorageAdapter;
    mailbox: Mailbox;
    clock: Clock;
  }

  const SWAP = {
    swap: true,
  };

  /** Fresh storage, an empty mailbox, and a clock at 1e6. */
  function fixtureOn(storageOptions: { swap?: boolean }): Fixture {
    return {
      storage: createInMemoryStorage(storageOptions),
      mailbox: [],
      clock: {
        t: 1e6,
      },
    };
  }

  const scope = {
    threadId: 't',
  };
  const delivery = {
    threadId: 't',
    messageId: 'm-1',
  };

  function assistantTexts(items: ReadonlyArray<Item>): string[] {
    return items.flatMap((item) => {
      if (item.type !== 'message' || item.role !== 'assistant') {
        return [];
      }
      return typeof item.content === 'string'
        ? [
            item.content,
          ]
        : [
            item.content.map((part) => ('text' in part ? part.text : '')).join(''),
          ];
    });
  }

  interface StoredSession {
    items: Item[];
    turn?: {
      parked?: {
        until: number;
      };
    };
  }

  /** Runs the flow on a first harness until it parks, then closes that harness. */
  async function parkOnFirstHarness(fixture: {
    storage: StorageAdapter;
    mailbox: Mailbox;
    clock: Clock;
  }): Promise<Model> {
    const first = model('a');
    const harness = harnessOver({
      ...fixture,
      m: first,
    });
    await harness.execute('hello', delivery);
    const response = await harness.getAgentResponse(scope);
    assert(response.parked);
    expect(response.parked.wakeAt).toBe(fixture.clock.t + DAY);
    expect(response.text).toBe('');
    await harness.close();
    return first;
  }

  it('parks at the wait: the response says so and storage holds the turn', async () => {
    const fixture = fixtureOn(SWAP);
    const first = await parkOnFirstHarness(fixture);
    expect(first.calls).toBe(1);

    const stored = await fixture.storage.get<StoredSession>('session:t');
    assert(stored?.turn?.parked);
    expect(stored.turn.parked.until).toBe(1e6 + DAY);
    // The lease was handed back, so no harness holds the parked turn.
    const lease = await fixture.storage.get<{
      heldUntil: number;
    }>('session:t:lease');
    expect(lease?.heldUntil).toBe(0);
  });

  it('survives a killed process and a 16-hour clock jump with no model call made twice', async () => {
    const fixture = fixtureOn(SWAP);
    const first = await parkOnFirstHarness(fixture);

    // Sixteen hours later a new process comes up over the same storage.
    fixture.clock.t += 16 * HOUR;
    const second = model('b');
    const harness = harnessOver({
      ...fixture,
      m: second,
    });
    // Nothing is due, so a routine wake leaves the turn parked.
    expect(await harness.wake()).toEqual([]);
    expect(await harness.nextWake()).toBe(1e6 + DAY);
    expect(second.calls).toBe(0);

    // The reply arrives; the host wakes the thread it belongs to.
    fixture.mailbox.push('approved');
    expect(await harness.wake(scope)).toEqual([
      't',
    ]);
    const response = await harness.getAgentResponse(scope);
    expect(response.parked).toBeUndefined();
    expect(response.text).toBe('b-1');

    // The plan was replayed from the ledger; only the answer was asked for.
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
    expect(assistantTexts(response.items)).toEqual([
      'a-1',
      'b-1',
    ]);
    const stored = await fixture.storage.get<StoredSession>('session:t');
    expect(stored?.turn).toBeUndefined();
    expect(await harness.nextWake()).toBeUndefined();
    await harness.close();
  });

  it('a woken turn with nothing to receive parks again', async () => {
    const fixture = fixtureOn(SWAP);
    await parkOnFirstHarness(fixture);

    const second = model('b');
    const harness = harnessOver({
      ...fixture,
      m: second,
    });
    expect(await harness.wake(scope)).toEqual([
      't',
    ]);
    const response = await harness.getAgentResponse(scope);
    assert(response.parked);
    // The deadline is the one the wait first set, not a new one.
    expect(response.parked.wakeAt).toBe(1e6 + DAY);
    expect(second.calls).toBe(0);
    await harness.close();
  });

  it('a routine wake resumes a turn whose deadline passed, and the wait times out', async () => {
    const fixture = fixtureOn(SWAP);
    await parkOnFirstHarness(fixture);

    const harness = harnessOver({
      ...fixture,
      m: model('b'),
    });
    fixture.clock.t = 1e6 + DAY - 1;
    expect(await harness.wake()).toEqual([]);
    fixture.clock.t = 1e6 + DAY;
    expect(await harness.wake()).toEqual([
      't',
    ]);
    try {
      await harness.getAgentResponse(scope);
      expect.unreachable('the wait should have timed out');
    } catch (error) {
      assert(isNoeticError(error));
      expect(error.noeticError.kind).toBe('step_failed');
    }
    await harness.close();
  });

  it('leaves a turn another harness holds alone', async () => {
    const fixture = fixtureOn(SWAP);
    // Parking off: the first harness holds the turn at the wait.
    const holder = harnessOver({
      ...fixture,
      m: model('a'),
      park: false,
    });
    await holder.execute('hello', delivery);
    for (let i = 0; i < 500 && !(await fixture.storage.get('session:t:lease')); i += 1) {
      await tick(1);
    }

    const other = harnessOver({
      ...fixture,
      m: model('b'),
    });
    expect(await other.wake()).toEqual([]);
    expect(await other.wake(scope)).toEqual([]);

    fixture.mailbox.push('go on');
    const response = await holder.getAgentResponse(scope);
    expect(response.parked).toBeUndefined();
    expect(response.text).toBe('a-2');
    await holder.close();
    await other.close();
  });

  it('does not park on storage without swap: the turn holds its process as before', async () => {
    const fixture = fixtureOn({});
    const m = model('a');
    const harness = harnessOver({
      ...fixture,
      m,
    });
    await harness.execute('hello', delivery);
    await tick(30);
    fixture.mailbox.push('later');
    const response = await harness.getAgentResponse(scope);
    expect(response.parked).toBeUndefined();
    expect(response.text).toBe('a-2');
    await harness.close();
  });
});
