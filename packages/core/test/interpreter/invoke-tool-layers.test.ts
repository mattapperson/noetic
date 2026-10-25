/**
 * An `invokeTool` step run through the interpreter is gated by the context's
 * `beforeToolCall` layers, in the order validation → layers → approver.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextLayer, SteeringDecision, ToolApprover } from '@noetic-tools/types';
import { frameworkCast, isNoeticError, SteeringAction } from '@noetic-tools/types';
import { z } from 'zod';
import { invokeTool } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';

//#region Helpers

interface Fixture {
  order: string[];
  run: () => Promise<unknown>;
}

function fixture(params: {
  decision: SteeringDecision;
  needsApproval?: boolean;
  approveToolCall?: ToolApprover;
}): Fixture {
  const order: string[] = [];
  const layer = frameworkCast<ContextLayer>({
    id: 'gate',
    slot: 0,
    scope: 'execution',
    hooks: {
      beforeToolCall: async (hook: { toolArgs: unknown }) => {
        order.push(`layer:${JSON.stringify(hook.toolArgs)}`);
        return {
          decision: params.decision,
        };
      },
    },
  });
  const harness = new AgentHarness({
    name: 'invoke-layers',
    params: {},
    approveToolCall: params.approveToolCall
      ? (approval) => {
          order.push('approver');
          return params.approveToolCall?.(approval) ?? allow;
        }
      : undefined,
  });
  const ctx = harness.createContext({
    contextLayers: [
      layer,
    ],
  });
  const step = invokeTool({
    id: 'add-step',
    tool: tool({
      name: 'add',
      description: 'Add',
      input: z.object({
        a: z.number(),
        b: z.coerce.number(),
      }),
      output: z.object({
        sum: z.number(),
      }),
      needsApproval: params.needsApproval,
      execute: async (args) => {
        order.push('execute');
        return {
          sum: args.a + args.b,
        };
      },
    }),
  });
  return {
    order,
    run: () =>
      harness.run(
        step,
        frameworkCast<{
          a: number;
          b: number;
        }>({
          a: 1,
          b: '2',
        }),
        ctx,
      ),
  };
}

const allow: SteeringDecision = {
  action: SteeringAction.Allow,
};

async function steeringDenial(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
  } catch (e) {
    assert(isNoeticError(e));
    assert(e.noeticError.kind === 'steering_denied');
    return e.noeticError.guidance;
  }
  throw new Error('expected steering_denied');
}

//#endregion

describe('interpreter invokeTool runs the beforeToolCall layers', () => {
  it('a denying layer blocks the step with steering_denied', async () => {
    const f = fixture({
      decision: {
        action: SteeringAction.Deny,
        guidance: 'blocked by policy',
      },
    });

    expect(await steeringDenial(f.run())).toBe('blocked by policy');
    expect(f.order).not.toContain('execute');
  });

  it('an allowing layer lets the step run, and sees validated args', async () => {
    const f = fixture({
      decision: allow,
    });

    expect(await f.run()).toEqual({
      sum: 3,
    });
    expect(f.order).toEqual([
      'layer:{"a":1,"b":2}',
      'execute',
    ]);
  });

  it('a guide decision refuses the step with steering_denied carrying the guidance', async () => {
    const f = fixture({
      decision: {
        action: SteeringAction.Guide,
        guidance: 'use the batch tool',
      },
    });

    expect(await steeringDenial(f.run())).toBe('use the batch tool');
    expect(f.order).not.toContain('execute');
  });

  it('the approver runs after the layers allow the call', async () => {
    const f = fixture({
      decision: allow,
      needsApproval: true,
      approveToolCall: () => allow,
    });

    await f.run();

    expect(f.order).toEqual([
      'layer:{"a":1,"b":2}',
      'approver',
      'execute',
    ]);
  });

  it('a layer denial means the approver is never asked', async () => {
    const f = fixture({
      decision: {
        action: SteeringAction.Deny,
        guidance: 'blocked by policy',
      },
      needsApproval: true,
      approveToolCall: () => allow,
    });

    await steeringDenial(f.run());

    expect(f.order).toEqual([
      'layer:{"a":1,"b":2}',
    ]);
  });
});
