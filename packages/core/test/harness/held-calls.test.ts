// Held tool calls: a call left open for a person, answered with `harness.resolve()`.
// Drives the real model client against a fake server. See specs/08-runtime § Held
// tool calls.

import { afterEach, describe, expect, it } from 'bun:test';
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
import { startFakeOpenRouter } from '../_helpers';

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

    await h.resolve(THREAD, {
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

    await h.resolve(THREAD, {
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

    await h.resolve(THREAD, {
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
    await h.execute('refund A1', THREAD);
    const held = await heldCall(h);
    expect(held.name).toBe('refund');

    await h.resolve(THREAD, {
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
        h.resolve(THREAD, {
          callId: 'call_nope',
          action: 'allow',
        }),
      ),
    ).toContain('no call with this id is held');
    expect(
      await refusal(() =>
        h.resolve(
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
        h.resolve(THREAD, {
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
        h.resolve(THREAD, {
          callId: held.callId,
          output: 'refunded by hand',
        }),
      ),
    ).toContain('waits for an approval');
    await h.abort(THREAD);
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

    await h.resolve(THREAD, {
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

    await h.resolve(THREAD, {
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
        h.resolve(THREAD, {
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

    await other.resolve(
      {
        executionId: await executionOf(storage),
      },
      {
        callId: held.callId,
        output: 'yes',
      },
    );
    await other.resolve(
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
        other.resolve(
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

    await second.resolve(THREAD, {
      callId: held.callId,
      argsHash: held.argsHash,
      action: 'allow',
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
