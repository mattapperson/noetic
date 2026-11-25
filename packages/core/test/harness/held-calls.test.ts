// Held tool calls: a call left open for a person, answered with a decision item
// passed to `harness.execute()`.
// Drives the real model client against a fake server. See specs/08-runtime § Held
// tool calls.

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { ContextData, HeldCall, ToolApprover } from '@noetic-tools/types';
import { isNoeticError, SteeringAction } from '@noetic-tools/types';
import { z } from 'zod';
import { callModel } from '../../src/builders/step-builders';
import { hold, tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { FakeOpenRouter } from '../_helpers';
import { slowStorage, startFakeOpenRouter } from '../_helpers';

//#region Fixtures

const OutputSchema = z.object({
  type: z.literal('function_call_output'),
  output: z.string(),
});

function outputsIn(input: unknown[]): string[] {
  return input.flatMap((entry) => {
    const parsed = OutputSchema.safeParse(entry);
    return parsed.success
      ? [
          parsed.data.output,
        ]
      : [];
  });
}

function call(name: string, args: Record<string, unknown>): unknown {
  return {
    type: 'function_call',
    id: `fc_${name}`,
    call_id: `call_${name}`,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
  };
}

function answer(text: string): unknown[] {
  return [
    {
      type: 'message',
      id: 'msg_done',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text,
          annotations: [],
        },
      ],
    },
  ];
}

/** One round asking for `calls`; once their results are in, an answer quoting them. */
function modelAsking(calls: unknown[]): (input: unknown[]) => unknown[] {
  return (input) => {
    const outputs = outputsIn(input);
    return outputs.length >= calls.length ? answer(outputs.join(' | ')) : calls;
  };
}

interface Setup {
  server: FakeOpenRouter;
  agent: ReturnType<typeof callModel<ContextData, string, string>>;
  /** Every time a tool body ran, by tool name. */
  runs: string[];
  harness: (opts?: { approveToolCall?: ToolApprover; storage?: StorageAdapter }) => AgentHarness;
}

const THREAD = {
  threadId: 't',
};

/**
 * `lookup` runs freely, `refund` needs approval, and `ask_person` posts a question
 * and leaves its result open.
 */
function setup(reply: (input: unknown[]) => unknown[]): Setup {
  const server = startFakeOpenRouter(reply);
  servers.push(server);
  const runs: string[] = [];
  const lookup = tool({
    name: 'lookup',
    description: 'Look an order up.',
    input: z.object({
      order: z.string(),
    }),
    output: z.string(),
    execute: async ({ order }) => {
      runs.push('lookup');
      return `order ${order} found`;
    },
  });
  const refund = tool({
    name: 'refund',
    description: 'Refund an order.',
    input: z.object({
      amount: z.number(),
    }),
    output: z.string(),
    needsApproval: true,
    execute: async ({ amount }) => {
      runs.push('refund');
      return `refunded ${amount}`;
    },
  });
  const askPerson = tool({
    name: 'ask_person',
    description: 'Ask a person a question.',
    input: z.object({
      question: z.string(),
    }),
    output: z.string(),
    execute: async ({ question }) => {
      runs.push('ask_person');
      return hold({
        request: {
          question,
        },
      });
    },
  });
  const agent = callModel<ContextData, string, string>({
    id: 'agent',
    model: 'test/model',
    tools: [
      lookup,
      refund,
      askPerson,
    ],
  });
  return {
    server,
    agent,
    runs,
    harness: (opts) =>
      new AgentHarness({
        name: 'held',
        params: {},
        agentGraph: agent,
        approveToolCall: opts?.approveToolCall,
        callModelDefaults: {
          provider: 'openrouter',
          apiKey: 'sk-test',
          baseUrl: server.baseUrl,
        },
        ...(opts?.storage
          ? {
              environment: {
                storage: {
                  adapter: opts.storage,
                  lease: {
                    waitMs: 0,
                  },
                  park: {
                    graceMs: 0,
                  },
                },
              },
            }
          : {}),
      }),
  };
}

const LOOKUP_THEN_REFUND = modelAsking([
  call('lookup', {
    order: 'A1',
  }),
  call('refund', {
    amount: 420,
  }),
]);

/** The one call the thread holds, once it holds it. */
async function heldCall(harness: AgentHarness): Promise<HeldCall> {
  for (let i = 0; i < 2e3; i += 1) {
    const [held] = await harness.pending(THREAD);
    if (held) {
      return held;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return expect.unreachable('no call was held');
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    assert(isNoeticError(error));
    assert(error.noeticError.kind === 'hold_refused');
    return error.noeticError.reason;
  }
  return expect.unreachable('expected hold_refused');
}

const holdIt: ToolApprover = () => ({
  action: SteeringAction.Hold,
});

const servers: FakeOpenRouter[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

//#endregion

/** Answer a held call the way a host does: a decision item passed to `execute()`. */
function decide(
  harness: Pick<AgentHarness, 'execute'>,
  scope: {
    threadId?: string;
  },
  decision:
    | {
        callId: string;
        argsHash?: string;
        action: 'allow' | 'deny' | 'guide';
        guidance?: string;
      }
    | {
        callId: string;
        argsHash?: string;
        output: unknown;
      },
): Promise<void> {
  return harness.execute(
    {
      type: 'noetic:decision',
      ...decision,
    },
    scope,
  );
}

describe('a call the approver holds', () => {
  it('waits for an answer while its siblings run, then runs once when allowed', async () => {
    const { runs, harness } = setup(LOOKUP_THEN_REFUND);
    const h = harness({
      approveToolCall: holdIt,
    });
    await h.execute('refund A1', THREAD);

    const held = await heldCall(h);
    expect(held).toMatchObject({
      callId: 'call_refund',
      name: 'refund',
      args: {
        amount: 420,
      },
      reason: 'approval',
    });
    // The sibling call ran; the held one did not.
    expect(runs).toEqual([
      'lookup',
    ]);

    await decide(h, THREAD, {
      callId: held.callId,
      argsHash: held.argsHash,
      action: 'allow',
    });
    const response = await h.getAgentResponse(THREAD);
    expect(response.text).toBe('order A1 found | refunded 420');
    expect(runs).toEqual([
      'lookup',
      'refund',
    ]);
    expect(await h.pending(THREAD)).toEqual([]);
  });

  it('is refused with the guidance when denied, and never runs', async () => {
    const { runs, harness } = setup(LOOKUP_THEN_REFUND);
    const h = harness({
      approveToolCall: holdIt,
    });
    await h.execute('refund A1', THREAD);
    const held = await heldCall(h);

    await decide(h, THREAD, {
      callId: held.callId,
      action: 'deny',
      guidance: 'over the limit',
    });
    const response = await h.getAgentResponse(THREAD);
    expect(response.text).toBe('order A1 found | Tool call denied: over the limit');
    expect(runs).toEqual([
      'lookup',
    ]);
  });

  it('is redirected with the guidance when guided', async () => {
    const { runs, harness } = setup(LOOKUP_THEN_REFUND);
    const h = harness({
      approveToolCall: holdIt,
    });
    await h.execute('refund A1', THREAD);
    const held = await heldCall(h);

    await decide(h, THREAD, {
      callId: held.callId,
      action: 'guide',
      guidance: 'offer store credit instead',
    });
    const response = await h.getAgentResponse(THREAD);
    expect(response.text).toContain('Tool call redirected: offer store credit instead');
    expect(runs).toEqual([
      'lookup',
    ]);
  });

  it('with no approver at all, is held the same way', async () => {
    const { runs, harness } = setup(LOOKUP_THEN_REFUND);
    const h = harness();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    await h.execute('refund A1', THREAD);
    const held = await heldCall(h);
    expect(held.name).toBe('refund');
    // Nothing will ask anyone, so the host is told where the call is waiting.
    const said = warn.mock.calls.map((call) => String(call[0])).filter((m) => m.includes('refund'));
    warn.mockRestore();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('harness.pending()');

    await decide(h, THREAD, {
      callId: held.callId,
      action: 'allow',
    });
    expect((await h.getAgentResponse(THREAD)).text).toContain('refunded 420');
    expect(runs).toEqual([
      'lookup',
      'refund',
    ]);
  });
});

describe('answers that are refused', () => {
  it('refuses an answer for a call that is not held', async () => {
    const { harness } = setup(LOOKUP_THEN_REFUND);
    const h = harness({
      approveToolCall: holdIt,
    });
    await h.execute('refund A1', THREAD);
    const held = await heldCall(h);

    expect(
      await refusal(() =>
        decide(h, THREAD, {
          callId: 'call_nope',
          action: 'allow',
        }),
      ),
    ).toContain('no call with this id is held');
    expect(
      await refusal(() =>
        h.resolveHeld(
          {
            threadId: 'another',
          },
          {
            callId: held.callId,
            action: 'allow',
          },
        ),
      ),
    ).toContain('no turn holding a call');
    await h.abort(THREAD);
  });

  it('refuses an approval given for different arguments: it is stale', async () => {
    const { runs, harness } = setup(LOOKUP_THEN_REFUND);
    const h = harness({
      approveToolCall: holdIt,
    });
    await h.execute('refund A1', THREAD);
    const held = await heldCall(h);

    expect(
      await refusal(() =>
        decide(h, THREAD, {
          callId: held.callId,
          argsHash: 'hash-of-what-the-reviewer-saw',
          action: 'allow',
        }),
      ),
    ).toContain('different arguments');
    // Nothing ran on a stale approval, and the call is still held.
    expect(runs).toEqual([
      'lookup',
    ]);
    expect(await h.pending(THREAD)).toHaveLength(1);
    await h.abort(THREAD);
  });

  it('refuses an output for a call that waits for approval', async () => {
    const { harness } = setup(LOOKUP_THEN_REFUND);
    const h = harness({
      approveToolCall: holdIt,
    });
    await h.execute('refund A1', THREAD);
    const held = await heldCall(h);

    expect(
      await refusal(() =>
        decide(h, THREAD, {
          callId: held.callId,
          output: 'refunded by hand',
        }),
      ),
    ).toContain('waits for an approval');
    await h.abort(THREAD);
  });
});

/** The kind and reason of the error `run` throws. */
async function thrown(run: () => Promise<unknown>): Promise<{
  kind: string;
  reason: string;
}> {
  try {
    await run();
  } catch (error) {
    assert(isNoeticError(error));
    const e = error.noeticError;
    assert(e.kind === 'hold_refused' || e.kind === 'decision_refused');
    return {
      kind: e.kind,
      reason: e.reason,
    };
  }
  return expect.unreachable('expected a refusal');
}

describe('a decision that does not fit', () => {
  /** A harness holding the refund, and a way to send it anything at all. */
  async function holding(): Promise<{
    h: AgentHarness;
    held: HeldCall;
    runs: string[];
    send: (decision: Record<string, unknown>) => Promise<void>;
  }> {
    const { runs, harness } = setup(LOOKUP_THEN_REFUND);
    const h = harness({
      approveToolCall: holdIt,
    });
    await h.execute('refund A1', THREAD);
    const held = await heldCall(h);
    return {
      h,
      held,
      runs,
      // A caller without types: the fields are whatever it sent.
      send: (decision) => h.execute(JSON.parse(JSON.stringify(decision)), THREAD),
    };
  }

  it('is refused when it carries both an action and an output', async () => {
    const { h, held, send } = await holding();
    expect(
      await thrown(() =>
        send({
          type: 'noetic:decision',
          callId: held.callId,
          action: 'allow',
          output: 'refunded by hand',
        }),
      ),
    ).toMatchObject({
      kind: 'decision_refused',
      reason: expect.stringContaining('both an action and an output'),
    });
    expect(await h.pending(THREAD)).toHaveLength(1);
    await h.abort(THREAD);
  });

  it('is refused when it settles a stuck turn but names a call, or answers one but names none', async () => {
    const { h, held, runs, send } = await holding();
    expect(
      await thrown(() =>
        send({
          type: 'noetic:decision',
          callId: held.callId,
          action: 'continue',
        }),
      ),
    ).toMatchObject({
      kind: 'decision_refused',
      reason: expect.stringContaining('takes no callId'),
    });
    expect(
      await thrown(() =>
        send({
          type: 'noetic:decision',
          action: 'allow',
        }),
      ),
    ).toMatchObject({
      kind: 'decision_refused',
      reason: expect.stringContaining('give its callId'),
    });
    // An output with no call to give it to, the same.
    expect(
      await thrown(() =>
        send({
          type: 'noetic:decision',
          output: 'done',
        }),
      ),
    ).toMatchObject({
      kind: 'decision_refused',
    });
    expect(runs).toEqual([
      'lookup',
    ]);
    await h.abort(THREAD);
  });

  it('is refused when its output cannot be recorded', async () => {
    const { h, held } = await holding();
    for (const output of [
      undefined,
      () => 'a function',
      1n,
    ]) {
      expect(
        await thrown(() =>
          decide(h, THREAD, {
            callId: held.callId,
            output,
          }),
        ),
      ).toMatchObject({
        kind: 'hold_refused',
        reason: expect.stringContaining('not a JSON value'),
      });
    }
    expect(await h.pending(THREAD)).toHaveLength(1);
    await h.abort(THREAD);
  });

  it('in a list, stops every decision in it: nothing is taken', async () => {
    const { h, held, runs } = await holding();
    expect(
      await thrown(() =>
        h.execute(
          [
            {
              type: 'noetic:decision',
              callId: held.callId,
              action: 'allow',
            },
            JSON.parse(
              JSON.stringify({
                type: 'noetic:decision',
                action: 'allow',
              }),
            ),
          ],
          THREAD,
        ),
      ),
    ).toMatchObject({
      kind: 'decision_refused',
    });
    // The first decision was fine, and was not taken: the refund did not run.
    expect(await h.pending(THREAD)).toHaveLength(1);
    expect(runs).toEqual([
      'lookup',
    ]);
    await h.abort(THREAD);
  });
});

describe('a function_call_output for a held call', () => {
  it('is refused: it would join the conversation and leave the call waiting', async () => {
    const { runs, harness } = setup(
      modelAsking([
        call('ask_person', {
          question: 'ship it?',
        }),
      ]),
    );
    const h = harness();
    await h.execute('ask', THREAD);
    const held = await heldCall(h);
    expect(
      await thrown(() =>
        h.execute(
          [
            {
              id: 'out-1',
              type: 'function_call_output',
              status: 'completed',
              callId: held.callId,
              output: 'yes',
            },
          ],
          THREAD,
        ),
      ),
    ).toMatchObject({
      kind: 'hold_refused',
      reason: expect.stringContaining('decision item'),
    });
    // Still held, and answered the right way it goes on.
    expect(await h.pending(THREAD)).toHaveLength(1);
    await decide(h, THREAD, {
      callId: held.callId,
      output: 'yes',
    });
    expect((await h.getAgentResponse(THREAD)).text).toBe('yes');
    expect(runs).toEqual([
      'ask_person',
    ]);
  });
});

describe('a hold with a deadline', () => {
  it('is denied when nobody answers in time', async () => {
    const { runs, harness } = setup(LOOKUP_THEN_REFUND);
    const h = harness({
      approveToolCall: () => ({
        action: SteeringAction.Hold,
        dueAt: Date.now() + 30,
      }),
    });
    await h.execute('refund A1', THREAD);

    const response = await h.getAgentResponse(THREAD);
    expect(response.text).toContain("nobody approved 'refund' before the hold ran out");
    expect(runs).toEqual([
      'lookup',
    ]);
  });

  it('stays held past its deadline when told to keep', async () => {
    const { harness } = setup(LOOKUP_THEN_REFUND);
    const h = harness({
      approveToolCall: () => ({
        action: SteeringAction.Hold,
        dueAt: Date.now() + 10,
        onDue: 'keep',
      }),
    });
    await h.execute('refund A1', THREAD);
    const held = await heldCall(h);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await h.pending(THREAD)).toHaveLength(1);

    await decide(h, THREAD, {
      callId: held.callId,
      action: 'allow',
    });
    expect((await h.getAgentResponse(THREAD)).text).toContain('refunded 420');
  });
});

describe('a tool that leaves its result open', () => {
  const ASK = modelAsking([
    call('ask_person', {
      question: 'Ship to the old address?',
    }),
  ]);

  it("takes the person's answer as its result, and its body runs once", async () => {
    const { runs, harness } = setup(ASK);
    const h = harness();
    await h.execute('check the address', THREAD);

    const held = await heldCall(h);
    expect(held).toMatchObject({
      callId: 'call_ask_person',
      reason: 'result',
      request: {
        question: 'Ship to the old address?',
      },
    });

    await decide(h, THREAD, {
      callId: held.callId,
      output: 'No, use the new one.',
    });
    expect((await h.getAgentResponse(THREAD)).text).toBe('No, use the new one.');
    expect(runs).toEqual([
      'ask_person',
    ]);
  });

  it('refuses an approval where a result is waited for', async () => {
    const { harness } = setup(ASK);
    const h = harness();
    await h.execute('check the address', THREAD);
    const held = await heldCall(h);

    expect(
      await refusal(() =>
        decide(h, THREAD, {
          callId: held.callId,
          action: 'allow',
        }),
      ),
    ).toContain('waits for a result');
    await h.abort(THREAD);
  });

  it('takes the first answer; the same again is a no-op and another is refused', async () => {
    const { harness } = setup(ASK);
    const storage = createInMemoryStorage({
      swap: true,
    });
    const h = harness({
      storage,
    });
    await h.execute('check the address', THREAD);
    // The turn parks on the held call, so its record outlives the answer landing.
    assert((await h.getAgentResponse(THREAD)).parked);
    const held = await heldCall(h);
    const other = harness({
      storage,
    });

    await other.resolveHeld(
      {
        executionId: await executionOf(storage),
      },
      {
        callId: held.callId,
        output: 'yes',
      },
    );
    await other.resolveHeld(
      {
        executionId: await executionOf(storage),
      },
      {
        callId: held.callId,
        output: 'yes',
      },
    );
    expect(
      await refusal(async () =>
        other.resolveHeld(
          {
            executionId: await executionOf(storage),
          },
          {
            callId: held.callId,
            output: 'no',
          },
        ),
      ),
    ).toContain('already answered differently');
  });
});

/** The execution of thread `t`'s stored turn. */
async function executionOf(storage: StorageAdapter): Promise<string> {
  const stored = await storage.get<{
    turn?: {
      executionId: string;
    };
  }>('session:t');
  assert(stored?.turn);
  return stored.turn.executionId;
}

describe('a held call on durable storage', () => {
  it('parks the turn, and another harness answers it and finishes with no call made twice', async () => {
    const { server, runs, harness } = setup(LOOKUP_THEN_REFUND);
    const storage = createInMemoryStorage({
      swap: true,
    });
    const first = harness({
      storage,
      approveToolCall: holdIt,
    });
    await first.execute('refund A1', {
      ...THREAD,
      messageId: 'm-1',
    });
    const parked = await first.getAgentResponse(THREAD);
    // Nothing is running, and nothing says when to wake: the turn waits for a person.
    assert(parked.parked);
    expect(parked.parked.wakeAt).toBeUndefined();
    expect(runs).toEqual([
      'lookup',
    ]);
    await first.close();

    // A routine wake leaves it alone.
    const second = harness({
      storage,
      approveToolCall: holdIt,
    });
    expect(await second.wake()).toEqual([]);
    const [held] = await second.pending(THREAD);
    assert(held);
    expect(held.name).toBe('refund');

    // What the host passes with the decision reaches the turn it resumes.
    const wake = spyOn(second, 'wake');
    const options = {
      ...THREAD,
      resourceId: 'the-approver',
    };
    await second.execute(
      {
        type: 'noetic:decision',
        callId: held.callId,
        argsHash: held.argsHash,
        action: 'allow',
      },
      options,
    );
    expect(wake).toHaveBeenCalledWith({
      threadId: 't',
      options,
    });
    const response = await second.getAgentResponse(THREAD);
    expect(response.parked).toBeUndefined();
    expect(response.text).toBe('order A1 found | refunded 420');
    // The lookup was replayed from its record; the refund ran once.
    expect(runs).toEqual([
      'lookup',
      'refund',
    ]);
    // Two model rounds in all: the one that asked for the calls, and the answer.
    expect(server.rounds).toHaveLength(2);
    expect(await second.pending(THREAD)).toEqual([]);
    await second.close();
  });
});

describe('a message that arrives while a call is held', () => {
  const TWO_REFUNDS = modelAsking([
    call('lookup', {
      order: 'A1',
    }),
    call('refund', {
      amount: 420,
    }),
  ]);

  async function parkOnRefund(setup: Setup, storage: StorageAdapter): Promise<AgentHarness> {
    const h = setup.harness({
      storage,
      approveToolCall: holdIt,
    });
    await h.execute('refund A1', {
      ...THREAD,
      messageId: 'm-1',
    });
    assert((await h.getAgentResponse(THREAD)).parked);
    return h;
  }

  it('waits behind the parked turn by default, and the turn is not lost', async () => {
    // Regression: a new message used to abandon the parked turn and orphan its held call.
    const fixture = setup(TWO_REFUNDS);
    const storage = createInMemoryStorage({
      swap: true,
    });
    const h = await parkOnRefund(fixture, storage);

    await h.execute('what is the status?', {
      ...THREAD,
      messageId: 'm-2',
    });
    // The parked turn and its held call are still there.
    const [held] = await h.pending(THREAD);
    assert(held);
    expect(held.name).toBe('refund');
    expect(fixture.runs).toEqual([
      'lookup',
    ]);

    await decide(h, THREAD, {
      callId: held.callId,
      action: 'allow',
    });
    await h.getAgentResponse(THREAD);
    expect(fixture.runs).toEqual([
      'lookup',
      'refund',
    ]);
    // The first turn finished with the refund, and the second saw all of it.
    const lastRound = fixture.server.rounds.at(-1);
    assert(lastRound);
    const sent = JSON.stringify(lastRound.input);
    expect(sent).toContain('refund A1');
    expect(sent).toContain('refunded 420');
    expect(sent).toContain('what is the status?');
    await h.close();
  });

  it('sent as a steer, skips the held call and the turn goes on with it', async () => {
    const fixture = setup(TWO_REFUNDS);
    const storage = createInMemoryStorage({
      swap: true,
    });
    const h = await parkOnRefund(fixture, storage);

    await h.execute('never mind the refund', {
      ...THREAD,
      messageId: 'm-2',
      deliveryMode: 'between-rounds',
    });
    const response = await h.getAgentResponse(THREAD);
    expect(response.parked).toBeUndefined();
    expect(response.text).toContain('Skipped: a new message arrived before this tool call ran.');
    // The lookup that had finished kept its result; the refund never ran.
    expect(response.text).toContain('order A1 found');
    expect(fixture.runs).toEqual([
      'lookup',
    ]);
    expect(await h.pending(THREAD)).toEqual([]);
    await h.close();
  });

  it('a steer into a turn that waits here, not parked, is offered at once', async () => {
    const fixture = setup(TWO_REFUNDS);
    const h = fixture.harness({
      approveToolCall: holdIt,
    });
    await h.execute('refund A1', THREAD);
    await heldCall(h);

    await h.execute('never mind the refund', {
      ...THREAD,
      deliveryMode: 'between-rounds',
    });
    const response = await h.getAgentResponse(THREAD);
    expect(response.text).toContain('Skipped: a new message arrived before this tool call ran.');
    expect(fixture.runs).toEqual([
      'lookup',
    ]);
    expect(await h.pending(THREAD)).toEqual([]);
  });
});

describe('an answer from another process', () => {
  it('reaches a turn that is waiting, not parked, on shared storage', async () => {
    // Regression: only the answering process was told, so the turn never moved.
    const fixture = setup(LOOKUP_THEN_REFUND);
    const storage = createInMemoryStorage({
      swap: true,
    });
    const waiting = new AgentHarness({
      name: 'held',
      params: {},
      agentGraph: fixture.agent,
      approveToolCall: holdIt,
      callModelDefaults: {
        provider: 'openrouter',
        apiKey: 'sk-test',
        baseUrl: fixture.server.baseUrl,
      },
      environment: {
        storage: {
          // Shared storage, parking off: the turn holds its process.
          adapter: storage,
          lease: {
            waitMs: 0,
          },
        },
      },
    });
    await waiting.execute('refund A1', {
      ...THREAD,
      messageId: 'm-1',
    });
    const held = await heldCall(waiting);

    const other = fixture.harness({
      storage,
      approveToolCall: holdIt,
    });
    await decide(other, THREAD, {
      callId: held.callId,
      action: 'allow',
    });
    const response = await waiting.getAgentResponse(THREAD);
    expect(response.text).toBe('order A1 found | refunded 420');
    expect(fixture.runs).toEqual([
      'lookup',
      'refund',
    ]);
    await waiting.close();
    await other.close();
  }, 15e3);

  it('is not missed when it lands while the turn is still reading its held calls', async () => {
    // Regression: the waiter registered after reading, so an answer in between was lost.
    const fixture = setup(
      modelAsking([
        call('refund', {
          amount: 1,
        }),
      ]),
    );
    const h = fixture.harness({
      storage: slowStorage(createInMemoryStorage(), 20),
      approveToolCall: holdIt,
    });
    await h.execute('refund', THREAD);
    const held = await heldCall(h);
    await decide(h, THREAD, {
      callId: held.callId,
      action: 'allow',
    });
    expect((await h.getAgentResponse(THREAD)).text).toBe('refunded 1');
  }, 15e3);
});

describe('a tool call key', () => {
  it('uses the root execution, so a child context that gets a new id keeps its key', async () => {
    const keys: Array<string | undefined> = [];
    const probe = tool({
      name: 'probe',
      description: 'Records its key.',
      input: z.object({}),
      output: z.string(),
      execute: async (_args, toolCtx) => {
        keys.push(toolCtx.idempotencyKey);
        return 'ok';
      },
    });
    const server = startFakeOpenRouter(
      modelAsking([
        call('probe', {}),
      ]),
    );
    servers.push(server);
    const h = new AgentHarness({
      name: 'keys',
      params: {},
      callModelDefaults: {
        provider: 'openrouter',
        apiKey: 'sk-test',
        baseUrl: server.baseUrl,
      },
    });
    const root = h.createContext();
    const child = h.createContext({
      parent: root,
    });
    await h.run(
      callModel<ContextData, string, string>({
        id: 'agent',
        model: 'test/model',
        tools: [
          probe,
        ],
      }),
      'go',
      child,
    );
    expect(keys).toEqual([
      `${root.id}:tool:call_probe`,
    ]);
    expect(child.id).not.toBe(root.id);
  });
});
