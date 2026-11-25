// Parked turns: a turn whose every step is waiting stops holding a process, and
// `harness.wake()` resumes it. See specs/23-durable-execution § Parked turns.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type {
  CallModelRequest,
  ContextData,
  Item,
  LLMResponse,
  StreamEvent,
} from '@noetic-tools/types';
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

/** Collects `stream` into `into` until an event of type `last`. */
async function collectUntil(
  stream: AsyncIterable<StreamEvent>,
  last: string,
  into: StreamEvent[],
): Promise<void> {
  for await (const event of stream) {
    into.push(event);
    if (event.type === last) {
      return;
    }
  }
}

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
                  autoWake: false,
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
    }>('turn-lease:t');
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
    expect(await harness.getNextWakeTime()).toBe(1e6 + DAY);
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
    expect(await harness.getNextWakeTime()).toBeUndefined();
    await harness.close();
  });

  describe("a wake with keptSteers: 'drop'", () => {
    const later = {
      threadId: 't',
      messageId: 'm-2',
    };

    /** Parks the flow, then sends it a message that waits in storage for the parked turn. */
    async function parkWithMessage(fixture: Fixture, m: Model): Promise<AgentHarness> {
      const harness = harnessOver({
        ...fixture,
        m,
      });
      await harness.execute('hello', delivery);
      assert((await harness.getAgentResponse(scope)).parked);
      await harness.execute('later', later);
      const stored = await fixture.storage.get<{
        steers?: {
          id: string;
        }[];
      }>('session:t');
      expect(stored?.steers?.map((kept) => kept.id)).toEqual([
        'm-2',
      ]);
      return harness;
    }

    function droppedIn(events: ReadonlyArray<StreamEvent>): unknown[] {
      return events
        .filter((event) => event.type === 'parking:steer_dropped')
        .map((event) => ('data' in event ? event.data : undefined));
    }

    it('delivers a next-turn message another process kept', async () => {
      const fixture = fixtureOn(SWAP);
      await (await parkWithMessage(fixture, model('a'))).close();

      const second = model('b');
      const harness = harnessOver({
        ...fixture,
        m: second,
      });
      const events: StreamEvent[] = [];
      const watching = collectUntil(harness.getFullStream(scope), 'parking:turn_completed', events);
      fixture.mailbox.push('approved');
      expect(
        await harness.wake({
          ...scope,
          options: {
            keptSteers: 'drop',
          },
        }),
      ).toEqual([
        't',
      ]);
      assert((await harness.getAgentResponse(scope)).parked);
      await watching;

      expect(droppedIn(events)).toEqual([]);
      await harness.waitForIdle();
      expect(second.calls).toBe(2);
      const stored = await harness.getStoredThread('t');
      assert(stored?.turn);
      expect(stored.turn.messageIds).toEqual([
        'm-2',
      ]);
      await harness.close();
    });

    it('keeps a message this process was sent, which runs once the turn ends', async () => {
      const fixture = fixtureOn(SWAP);
      const m = model('a');
      const harness = await parkWithMessage(fixture, m);

      fixture.mailbox.push('approved');
      await harness.wake({
        ...scope,
        options: {
          keptSteers: 'drop',
        },
      });
      await harness.getAgentResponse(scope);
      await harness.waitForIdle();

      // The plan, the answer, and the kept message's own turn.
      expect(m.calls).toBe(3);
      expect(
        (
          await fixture.storage.get<{
            steers?: unknown[];
          }>('session:t')
        )?.steers ?? [],
      ).toEqual([]);
      await harness.close();
    });
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
    // It failed here, in a live process: a routine wake does not run it again.
    expect(await harness.wake()).toEqual([]);
    expect(await harness.wake()).toEqual([]);
    // Asking for the thread by name still does.
    expect(await harness.wake(scope)).toEqual([
      't',
    ]);
    await harness.getAgentResponse(scope).catch(() => {});
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
    // Until the turn is on record and its lease is held.
    const turnOnRecord = async (): Promise<boolean> => {
      const stored = await fixture.storage.get<{
        turn?: object;
      }>('session:t');
      return stored?.turn !== undefined && (await fixture.storage.get('turn-lease:t')) !== null;
    };
    for (let i = 0; i < 500 && !(await turnOnRecord()); i += 1) {
      await tick(1);
    }

    const other = harnessOver({
      ...fixture,
      m: model('b'),
    });
    // A routine wake passes over it.
    expect(await other.wake()).toEqual([]);
    // Asked for by name, the wake goes for the turn, cannot have it, and says so:
    // the caller hears `lease_lost` rather than "there was nothing to wake".
    expect(await other.wake(scope)).toEqual([
      't',
    ]);
    const refused = await other.getAgentResponse(scope).then(
      () => 'answered',
      (error: unknown) => (isNoeticError(error) ? error.noeticError.kind : 'threw'),
    );
    expect(refused).toBe('lease_lost');

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

  describe('woken by the harness that parked it', () => {
    /** A flow like `flow`, counting how often it started and taking only `accept`ed replies. */
    function countingFlow(opts: { timeoutMs: number; accept?: string }): {
      starts: () => number;
      graph: typeof flow;
    } {
      let starts = 0;
      const wait = step.wait({
        id: 'wait',
        connection: 'inbox',
        event: 'reply',
        timeoutMs: opts.timeoutMs,
        ...(opts.accept === undefined
          ? {}
          : {
              filter: (event) => WaitedSchema.shape.event.parse(event).payload.text === opts.accept,
            }),
      });
      return {
        starts: () => starts,
        graph: runCode<ContextData, string, string>({
          id: 'flow',
          execute: async (input, execCtx) => {
            starts += 1;
            await execCtx.harness.run(turn('plan'), input, execCtx);
            const waited = WaitedSchema.parse(await execCtx.harness.run(wait, undefined, execCtx));
            return String(
              await execCtx.harness.run(turn('answer'), waited.event.payload.text, execCtx),
            );
          },
        }),
      };
    }

    function watchfulHarness(opts: {
      storage: StorageAdapter;
      m: Model;
      mailbox: Mailbox;
      graph: typeof flow;
    }): AgentHarness {
      return new AgentHarness({
        name: 'parking',
        params: {},
        agentGraph: opts.graph,
        connections: {
          inbox: inbox(opts.mailbox),
        },
        environment: {
          storage: {
            adapter: opts.storage,
            lease: {
              waitMs: 0,
            },
            park: {
              graceMs: 0,
              wakeDebounceMs: 10,
            },
          },
        },
        _testCallModel: (request) => opts.m.call(request),
      });
    }

    /**
     * The turn's response once it has stopped being parked. `getAgentResponse`
     * answers with the last response while nothing runs, so ask until it changes.
     */
    async function onceWoken(harness: AgentHarness) {
      for (let i = 0; i < 400; i += 1) {
        const response = await harness.getAgentResponse(scope);
        if (!response.parked) {
          return response;
        }
        await tick(5);
      }
      return expect.unreachable('the turn stayed parked');
    }

    async function storedTurn(storage: StorageAdapter): Promise<StoredSession['turn']> {
      return (await storage.get<StoredSession>('session:t'))?.turn;
    }

    it('finishes when the reply arrives, with nothing calling wake()', async () => {
      const storage = createInMemoryStorage(SWAP);
      const mailbox: Mailbox = [];
      const m = model('a');
      const counted = countingFlow({
        timeoutMs: DAY,
      });
      const harness = watchfulHarness({
        storage,
        m,
        mailbox,
        graph: counted.graph,
      });
      await harness.execute('hello', delivery);
      assert((await harness.getAgentResponse(scope)).parked);

      mailbox.push('approved');
      const response = await onceWoken(harness);
      expect(response.text).toBe('a-2');
      // Planned once, answered once: the plan was replayed, not asked again.
      expect(m.calls).toBe(2);
      expect(await storedTurn(storage)).toBeUndefined();
      await harness.close();
    });

    it('wakes once for a reply the flow turns down, then parks again', async () => {
      const storage = createInMemoryStorage(SWAP);
      const mailbox: Mailbox = [];
      const m = model('a');
      const counted = countingFlow({
        timeoutMs: DAY,
        accept: 'approved',
      });
      const harness = watchfulHarness({
        storage,
        m,
        mailbox,
        graph: counted.graph,
      });
      await harness.execute('hello', delivery);
      assert((await harness.getAgentResponse(scope)).parked);
      expect(counted.starts()).toBe(1);

      // Not the reply it waits for: the turn looks, and parks again.
      mailbox.push('thanks!');
      await tick(120);
      assert((await storedTurn(storage))?.parked);
      // It woke for that event once, not over and over.
      expect(counted.starts()).toBe(2);
      expect(m.calls).toBe(1);

      mailbox.push('approved');
      const response = await onceWoken(harness);
      expect(response.text).toBe('a-2');
      expect(counted.starts()).toBe(3);
      await harness.close();
    });

    it('wakes at the deadline, and the wait times out', async () => {
      const storage = createInMemoryStorage(SWAP);
      const counted = countingFlow({
        timeoutMs: 60,
      });
      const harness = watchfulHarness({
        storage,
        m: model('a'),
        mailbox: [],
        graph: counted.graph,
      });
      await harness.execute('hello', delivery);
      assert((await harness.getAgentResponse(scope)).parked);

      try {
        await onceWoken(harness);
        expect.unreachable('the wait should have timed out');
      } catch (error) {
        assert(isNoeticError(error));
        expect(error.noeticError.kind).toBe('step_failed');
      }
      await harness.close();
    });

    it('a new process watches over the parked turns it finds at boot', async () => {
      const storage = createInMemoryStorage(SWAP);
      const mailbox: Mailbox = [];
      const first = countingFlow({
        timeoutMs: DAY,
      });
      const before = watchfulHarness({
        storage,
        m: model('a'),
        mailbox,
        graph: first.graph,
      });
      await before.execute('hello', delivery);
      assert((await before.getAgentResponse(scope)).parked);
      await before.close();

      const m = model('b');
      const second = countingFlow({
        timeoutMs: DAY,
      });
      const after = watchfulHarness({
        storage,
        m,
        mailbox,
        graph: second.graph,
      });
      // The one call a host makes at boot. Nothing is due, so nothing resumes yet.
      expect(await after.wake()).toEqual([]);

      mailbox.push('approved');
      // This harness has run no turn yet, so there is no last response to mistake.
      const response = await after.getAgentResponse(scope);
      expect(response.text).toBe('b-1');
      expect(m.calls).toBe(1);
      await after.close();
    });

    it('with autoWake off, a reply leaves the turn parked until wake() is called', async () => {
      const fixture = fixtureOn(SWAP);
      const m = model('a');
      const harness = harnessOver({
        ...fixture,
        m,
      });
      await harness.execute('hello', delivery);
      assert((await harness.getAgentResponse(scope)).parked);

      fixture.mailbox.push('approved');
      await tick(80);
      assert((await storedTurn(fixture.storage))?.parked);
      expect(m.calls).toBe(1);

      expect(await harness.wake(scope)).toEqual([
        't',
      ]);
      expect((await harness.getAgentResponse(scope)).text).toBe('a-2');
      await harness.close();
    });
  });
});
