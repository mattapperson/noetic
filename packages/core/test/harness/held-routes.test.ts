// Every path that asks a person goes through the one approval seam, and holds:
// a step's connection call, a long task's question, an `invokeTool` step, and
// `harness.approve()` itself. See specs/08-runtime § Held tool calls.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData, HeldCall } from '@noetic-tools/types';
import { SteeringAction } from '@noetic-tools/types';
import { z } from 'zod';
import { invokeTool, runCode, step } from '../../src/builders/step-builders';
import { hold, tool } from '../../src/builders/tool-builder';
import { createInMemoryConnection } from '../../src/connections/in-memory-connection';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';

//#region Fixtures

/** A connection with a guarded write and an install that asks a question part way. */
function appConnection(installs: unknown[] = []) {
  return createInMemoryConnection({
    operations: {
      'app.wipe': {
        guarded: true,
        run: () => ({
          wiped: true,
        }),
      },
      'app.install': {
        task: [
          {
            state: 'input_required',
            request: {
              id: 'q1',
              message: 'Trust this developer?',
            },
          },
        ],
        run: (_args, context) => {
          const trusted = context.answers.get('q1');
          installs.push(trusted);
          return {
            trusted,
          };
        },
      },
    },
  });
}

/** The first call the execution or thread holds, once it holds one. */
async function heldCall(
  harness: AgentHarness,
  scope:
    | {
        executionId: string;
      }
    | {
        threadId: string;
      },
): Promise<HeldCall> {
  for (let i = 0; i < 2e3; i += 1) {
    const [held] = await harness.pending(scope);
    if (held) {
      return held;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return expect.unreachable('no call was held');
}

//#endregion

describe("a step's connection call that needs approval", () => {
  it('is held with no approver, and runs once a person allows it', async () => {
    const harness = new AgentHarness({
      name: 'routes',
      params: {},
      connections: {
        app: appConnection(),
      },
    });
    const ctx = harness.createContext();
    const scope = {
      executionId: ctx.id,
    };
    const running = harness.run(
      step.call({
        id: 'wipe',
        connection: 'app',
        op: 'app.wipe',
      }),
      undefined,
      ctx,
    );

    const held = await heldCall(harness, scope);
    expect(held).toMatchObject({
      name: 'app_app_wipe',
      reason: 'approval',
    });
    // A run the host started itself has no thread: the decision names the run.
    await harness.execute({
      type: 'noetic:decision',
      callId: held.callId,
      executionId: ctx.id,
      action: 'allow',
    });
    expect(await running).toEqual({
      wiped: true,
    });
    expect(await harness.pending(scope)).toEqual([]);
    await harness.close();
  });

  it('is refused when the person denies it', async () => {
    const harness = new AgentHarness({
      name: 'routes',
      params: {},
      connections: {
        app: appConnection(),
      },
    });
    const ctx = harness.createContext();
    const scope = {
      executionId: ctx.id,
    };
    const running = harness.run(
      step.call({
        id: 'wipe',
        connection: 'app',
        op: 'app.wipe',
      }),
      undefined,
      ctx,
    );
    const held = await heldCall(harness, scope);
    await harness.resolveHeld(scope, {
      callId: held.callId,
      action: 'deny',
      guidance: 'not on a Friday',
    });
    await expect(running).rejects.toThrow('not on a Friday');
    await harness.close();
  });
});

describe('a question a long task asks', () => {
  it('is held for a person, and their answer goes back to the task', async () => {
    const installs: unknown[] = [];
    const harness = new AgentHarness({
      name: 'routes',
      params: {},
      connections: {
        app: appConnection(installs),
      },
    });
    const ctx = harness.createContext();
    const scope = {
      executionId: ctx.id,
    };
    const running = harness.run(
      step.call({
        id: 'install',
        connection: 'app',
        op: 'app.install',
      }),
      undefined,
      ctx,
    );

    const held = await heldCall(harness, scope);
    expect(held).toMatchObject({
      reason: 'result',
      request: {
        id: 'q1',
        message: 'Trust this developer?',
      },
    });
    await harness.resolveHeld(scope, {
      callId: held.callId,
      output: 'yes',
    });
    expect(await running).toEqual({
      trusted: 'yes',
    });
    expect(installs).toEqual([
      'yes',
    ]);
    await harness.close();
  });

  it('parks the turn, which finishes once the question is answered', async () => {
    const installs: unknown[] = [];
    const install = step.call({
      id: 'install',
      connection: 'app',
      op: 'app.install',
    });
    const harness = new AgentHarness({
      name: 'routes',
      params: {},
      connections: {
        app: appConnection(installs),
      },
      agentGraph: runCode<ContextData, string, string>({
        id: 'flow',
        execute: async (_input, execCtx) =>
          JSON.stringify(await execCtx.harness.run(install, undefined, execCtx)),
      }),
      environment: {
        storage: {
          adapter: createInMemoryStorage({
            swap: true,
          }),
          lease: {
            waitMs: 0,
          },
          park: {
            graceMs: 0,
            taskPollMs: 10,
          },
        },
      },
    });
    const thread = {
      threadId: 't',
    };
    await harness.execute('install it', {
      ...thread,
      messageId: 'm-1',
    });
    const parked = await harness.getAgentResponse(thread);
    // The parked response says what the turn is waiting on.
    assert(parked.parked);
    assert(parked.held);
    expect(parked.held).toHaveLength(1);
    const [held] = parked.held;
    assert(held);
    expect(held.request).toMatchObject({
      message: 'Trust this developer?',
    });

    // The person's answer is a decision item.
    await harness.execute(
      {
        type: 'noetic:decision',
        callId: held.callId,
        output: 'yes',
      },
      thread,
    );
    const done = await harness.getAgentResponse(thread);
    expect(done.parked).toBeUndefined();
    expect(done.text).toBe('{"trusted":"yes"}');
    // The task was not started again, and it was not cancelled when the turn parked.
    expect(installs).toEqual([
      'yes',
    ]);
    await harness.close();
  });
});

describe('an invokeTool step', () => {
  it('asks its question once, though the turn parks on it and another process wakes it', async () => {
    // Regression: the woken step ran the tool's body again, asking a second time.
    let asked = 0;
    const ask = tool({
      name: 'ask_person',
      description: 'Ask a person.',
      input: z.object({
        question: z.string(),
      }),
      output: z.string(),
      execute: async ({ question }) => {
        asked += 1;
        return hold({
          request: {
            question,
          },
        });
      },
    });
    const storage = createInMemoryStorage({
      swap: true,
    });
    const build = (): AgentHarness =>
      new AgentHarness({
        name: 'routes',
        params: {},
        agentGraph: runCode<ContextData, string, string>({
          id: 'flow',
          execute: async (_input, execCtx) =>
            String(
              await execCtx.harness.run(
                invokeTool({
                  id: 'ask',
                  tool: ask,
                }),
                {
                  question: 'Ship it?',
                },
                execCtx,
              ),
            ),
        }),
        environment: {
          storage: {
            adapter: storage,
            lease: {
              waitMs: 0,
            },
            park: {
              graceMs: 0,
              autoWake: false,
            },
          },
        },
      });
    const thread = {
      threadId: 't',
    };
    const first = build();
    await first.execute('go', {
      ...thread,
      messageId: 'm-1',
    });
    assert((await first.getAgentResponse(thread)).parked);
    await first.close();

    const second = build();
    const [held] = await second.pending(thread);
    assert(held);
    expect(held.reason).toBe('result');
    await second.execute(
      {
        type: 'noetic:decision',
        callId: held.callId,
        output: 'Yes, ship it.',
      },
      thread,
    );
    expect((await second.getAgentResponse(thread)).text).toBe('Yes, ship it.');
    expect(asked).toBe(1);
    await second.close();
  });

  it("takes a person's answer as the result of a tool that returned hold()", async () => {
    let asked = 0;
    const ask = tool({
      name: 'ask_person',
      description: 'Ask a person.',
      input: z.object({
        question: z.string(),
      }),
      output: z.string(),
      execute: async ({ question }) => {
        asked += 1;
        return hold({
          request: {
            question,
          },
        });
      },
    });
    const harness = new AgentHarness({
      name: 'routes',
      params: {},
    });
    const ctx = harness.createContext();
    const scope = {
      executionId: ctx.id,
    };
    const running = harness.run(
      invokeTool({
        id: 'ask',
        tool: ask,
      }),
      {
        question: 'Ship it?',
      },
      ctx,
    );
    const held = await heldCall(harness, scope);
    expect(held).toMatchObject({
      name: 'ask_person',
      reason: 'result',
      request: {
        question: 'Ship it?',
      },
    });
    await harness.resolveHeld(scope, {
      callId: held.callId,
      output: 'Yes, ship it.',
    });
    expect(await running).toBe('Yes, ship it.');
    expect(asked).toBe(1);
  });

  it('does not repeat a durable tool that a crash cut off: its outcome is held', async () => {
    const attempts: number[] = [];
    let hung = false;
    const charge = tool({
      name: 'charge',
      description: 'Charge a card.',
      input: z.object({
        amount: z.number(),
      }),
      output: z.object({
        charged: z.number(),
      }),
      durable: true,
      execute: async ({ amount }) => {
        attempts.push(amount);
        if (!hung) {
          hung = true;
          await new Promise(() => {});
        }
        return {
          charged: amount,
        };
      },
    });
    const chargeStep = invokeTool({
      id: 'charge',
      tool: charge,
    });
    const storage = createInMemoryStorage();
    const first = new AgentHarness({
      name: 'routes',
      params: {},
      environment: {
        storage: {
          adapter: storage,
        },
      },
    });
    const ctx = first.createContext();
    // The host dies inside the charge.
    void first
      .run(
        chargeStep,
        {
          amount: 42,
        },
        ctx,
      )
      .catch(() => {});
    for (let i = 0; i < 2e3 && attempts.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const next = new AgentHarness({
      name: 'routes',
      params: {},
      environment: {
        storage: {
          adapter: storage,
        },
      },
    });
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    const scope = {
      executionId: ctx.id,
    };
    const running = next.run(
      chargeStep,
      {
        amount: 42,
      },
      resumed,
    );
    const held = await heldCall(next, scope);
    expect(held).toMatchObject({
      name: 'charge',
      reason: 'outcome',
    });
    // The person checked the processor: the charge went through.
    await next.resolveHeld(scope, {
      callId: held.callId,
      output: {
        charged: 42,
      },
    });
    expect(await running).toEqual({
      charged: 42,
    });
    expect(attempts).toEqual([
      42,
    ]);
  });
});

describe('harness.approve()', () => {
  it('answers from the approver when there is one', async () => {
    const harness = new AgentHarness({
      name: 'routes',
      params: {},
      approveToolCall: () => ({
        action: SteeringAction.Deny,
        guidance: 'no',
      }),
    });
    const ctx = harness.createContext();
    expect(
      await harness.approve({
        toolName: 'deploy',
        toolArgs: {},
        callId: 'd-1',
        ctx,
      }),
    ).toEqual({
      action: 'deny',
      guidance: 'no',
    });
  });

  it("holds with no approver, and resolves with the person's decision", async () => {
    const harness = new AgentHarness({
      name: 'routes',
      params: {},
    });
    const ctx = harness.createContext();
    const scope = {
      executionId: ctx.id,
    };
    const asking = harness.approve({
      toolName: 'deploy',
      toolArgs: {
        to: 'prod',
      },
      callId: 'd-1',
      ctx,
    });
    const held = await heldCall(harness, scope);
    expect(held).toMatchObject({
      callId: 'd-1',
      name: 'deploy',
      args: {
        to: 'prod',
      },
    });
    await harness.resolveHeld(scope, {
      callId: 'd-1',
      action: 'allow',
    });
    expect(await asking).toMatchObject({
      action: 'allow',
    });
  });
});

describe("an invokeTool step's idempotency key", () => {
  it('is the same on a resumed run, and differs between two steps', async () => {
    const keys: Array<string | undefined> = [];
    let hung = false;
    const charge = tool({
      name: 'charge',
      description: 'Charge a card.',
      input: z.object({
        amount: z.number(),
      }),
      output: z.string(),
      execute: async (_args, toolCtx) => {
        keys.push(toolCtx.idempotencyKey);
        // The host dies inside the second charge, the first time round.
        if (keys.length === 2 && !hung) {
          hung = true;
          await new Promise(() => {});
        }
        return 'charged';
      },
    });
    const deposit = invokeTool({
      id: 'charge-deposit',
      tool: charge,
    });
    const balance = invokeTool({
      id: 'charge-balance',
      tool: charge,
    });
    const args = {
      amount: 42,
    };
    // One run that makes both charges, so a resume replays the first.
    const both = runCode<ContextData, undefined, string>({
      id: 'both',
      execute: async (_input, execCtx) => {
        await execCtx.harness.run(deposit, args, execCtx);
        return String(await execCtx.harness.run(balance, args, execCtx));
      },
    });
    const storage = createInMemoryStorage();
    const build = (): AgentHarness =>
      new AgentHarness({
        name: 'routes',
        params: {},
        environment: {
          storage: {
            adapter: storage,
          },
        },
      });
    const before = build();
    const ctx = before.createContext();
    void before.run(both, undefined, ctx).catch(() => {});
    for (let i = 0; i < 2e3 && keys.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const [depositKey, balanceKey] = keys;
    assert(depositKey);
    assert(balanceKey);
    expect(depositKey).not.toBe(balanceKey);
    expect(depositKey.startsWith(`${ctx.id}:tool:`)).toBe(true);

    // A new process resumes the run: the deposit replays, the balance is sent
    // again with the key it had, so the processor can tell it is the same charge.
    const after = build();
    const resumed = await after.restore(ctx.id);
    assert(resumed);
    expect(await after.run(both, undefined, resumed)).toBe('charged');
    expect(keys).toEqual([
      depositKey,
      balanceKey,
      balanceKey,
    ]);
  });
});

describe('a call held for one thing after another', () => {
  /** A tool that needs approval, then leaves its result for a person. */
  function askAfterApproval(runs: string[]) {
    return invokeTool({
      id: 'ask',
      tool: tool({
        name: 'ask_person',
        description: 'Ask a person.',
        input: z.object({
          question: z.string(),
        }),
        output: z.string(),
        needsApproval: true,
        execute: async ({ question }) => {
          runs.push(question);
          return hold({
            request: {
              question,
            },
          });
        },
      }),
    });
  }

  it('asks for approval, runs the body once, then asks for the result', async () => {
    const runs: string[] = [];
    const harness = new AgentHarness({
      name: 'routes',
      params: {},
    });
    const ctx = harness.createContext();
    const scope = {
      executionId: ctx.id,
    };
    const running = harness.run(
      askAfterApproval(runs),
      {
        question: 'Ship it?',
      },
      ctx,
    );
    const approval = await heldCall(harness, scope);
    expect(approval.reason).toBe('approval');
    expect(runs).toEqual([]);
    await harness.resolveHeld(scope, {
      callId: approval.callId,
      action: 'allow',
    });

    // The approval is spent: what is held now is a different question.
    let result: HeldCall | undefined;
    for (let i = 0; i < 2e3 && result?.reason !== 'result'; i += 1) {
      [result] = await harness.pending(scope);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert(result);
    expect(result.reason).toBe('result');
    expect(runs).toEqual([
      'Ship it?',
    ]);
    await harness.resolveHeld(scope, {
      callId: result.callId,
      output: 'Yes.',
    });
    expect(await running).toBe('Yes.');
    expect(runs).toEqual([
      'Ship it?',
    ]);
    expect(await harness.pending(scope)).toEqual([]);
  });
});

describe('an approval, once used', () => {
  function gatedAdd(runs: number[]) {
    return invokeTool({
      id: 'add',
      tool: tool({
        name: 'add',
        description: 'Add one.',
        input: z.object({
          n: z.number(),
        }),
        output: z.number(),
        needsApproval: true,
        execute: async ({ n }) => {
          runs.push(n);
          return n + 1;
        },
      }),
    });
  }
  const args = {
    n: 7,
  };

  it('does not approve the same step asking again with the same arguments', async () => {
    const runs: number[] = [];
    const addStep = gatedAdd(runs);
    const harness = new AgentHarness({
      name: 'routes',
      params: {},
      environment: {
        storage: {
          adapter: createInMemoryStorage(),
        },
      },
    });
    const ctx = harness.createContext();
    const scope = {
      executionId: ctx.id,
    };
    const first = harness.run(addStep, args, ctx);
    const held = await heldCall(harness, scope);
    await harness.resolveHeld(scope, {
      callId: held.callId,
      action: 'allow',
    });
    expect(await first).toBe(8);

    // The same step, the same arguments, a second time: a person is asked again.
    const second = harness.run(addStep, args, ctx);
    const again = await heldCall(harness, scope);
    expect(again.callId).not.toBe(held.callId);
    expect(runs).toEqual([
      7,
    ]);
    await harness.resolveHeld(scope, {
      callId: again.callId,
      action: 'deny',
    });
    await expect(second).rejects.toThrow();
    expect(runs).toEqual([
      7,
    ]);
  });

  it('covers one call: two at once under one step id are two questions', async () => {
    const runs: number[] = [];
    const addStep = gatedAdd(runs);
    // No storage: the calls have no ledger path to tell them apart.
    const harness = new AgentHarness({
      name: 'routes',
      params: {},
    });
    const ctx = harness.createContext();
    const scope = {
      executionId: ctx.id,
    };
    const a = harness.run(addStep, args, ctx);
    const b = harness.run(addStep, args, ctx);
    b.catch(() => {});
    let held: HeldCall[] = [];
    for (let i = 0; i < 2e3 && held.length < 2; i += 1) {
      held = await harness.pending(scope);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(held).toHaveLength(2);
    const [one, two] = held;
    assert(one);
    assert(two);
    await harness.resolveHeld(scope, {
      callId: one.callId,
      action: 'allow',
    });
    await Promise.race([
      a,
      b,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toEqual([
      7,
    ]);
    await harness.resolveHeld(scope, {
      callId: two.callId,
      action: 'deny',
    });
    await Promise.allSettled([
      a,
      b,
    ]);
    expect(runs).toEqual([
      7,
    ]);
  });

  it('is the first of two answers given at once, on storage with no swap', async () => {
    const runs: number[] = [];
    const harness = new AgentHarness({
      name: 'routes',
      params: {},
    });
    const ctx = harness.createContext();
    const scope = {
      executionId: ctx.id,
    };
    const running = harness.run(gatedAdd(runs), args, ctx);
    running.catch(() => {});
    const held = await heldCall(harness, scope);
    const answers = await Promise.allSettled([
      harness.resolveHeld(scope, {
        callId: held.callId,
        action: 'allow',
      }),
      harness.resolveHeld(scope, {
        callId: held.callId,
        action: 'deny',
      }),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(await running).toBe(8);
  });
});

describe('a durable tool that needed approval and was cut off', () => {
  it('asks a person how it ended, not for the approval it already had', async () => {
    const attempts: number[] = [];
    let hung = false;
    const shipStep = invokeTool({
      id: 'ship',
      tool: tool({
        name: 'ship',
        description: 'Ship an order.',
        input: z.object({
          n: z.number(),
        }),
        output: z.string(),
        needsApproval: true,
        durable: true,
        execute: async ({ n }) => {
          attempts.push(n);
          if (!hung) {
            hung = true;
            await new Promise(() => {});
          }
          return `shipped ${n}`;
        },
      }),
    });
    const storage = createInMemoryStorage();
    const build = (): AgentHarness =>
      new AgentHarness({
        name: 'routes',
        params: {},
        environment: {
          storage: {
            adapter: storage,
          },
        },
      });
    const input = {
      n: 1,
    };
    const first = build();
    const ctx = first.createContext();
    const scope = {
      executionId: ctx.id,
    };
    void first.run(shipStep, input, ctx).catch(() => {});
    const approval = await heldCall(first, scope);
    await first.resolveHeld(scope, {
      callId: approval.callId,
      action: 'allow',
    });
    for (let i = 0; i < 2e3 && attempts.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(attempts).toEqual([
      1,
    ]);

    // The host died inside the tool. The next one must not spin, and must ask.
    const next = build();
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    const running = next.run(shipStep, input, resumed);
    let outcome: HeldCall | undefined;
    for (let i = 0; i < 2e3 && outcome?.reason !== 'outcome'; i += 1) {
      [outcome] = await next.pending(scope);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert(outcome);
    expect(outcome.reason).toBe('outcome');
    await next.resolveHeld(scope, {
      callId: outcome.callId,
      output: 'shipped 1',
    });
    expect(await running).toBe('shipped 1');
    expect(attempts).toEqual([
      1,
    ]);
  });
});
