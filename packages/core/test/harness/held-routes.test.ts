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
    await harness.resolveHeld(scope, {
      callId: held.callId,
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

    // The answer comes in the way any tool result does: an item passed to execute().
    await harness.execute(
      {
        id: 'answer-1',
        type: 'function_call_output',
        status: 'completed',
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
