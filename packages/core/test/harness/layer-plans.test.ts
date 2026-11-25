/**
 * A context layer that keeps the agent's plan reports it as an agent step's
 * agent does: `plan_updated` when it changes, `plan_removed` when it goes
 * (spec 08 § Tool calls, plans and agent settings).
 */

import { describe, expect, it } from 'bun:test';
import { plan } from '@noetic-tools/context';
import type { ContextLayer, LLMResponse } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { AgentHarness } from '../../src/harness/agent-harness';
import { reportLayerPlans } from '../../src/runtime/layer-plans';

//#region Helpers

interface Emitted {
  type: string;
  data: Record<string, unknown>;
}

/** A model that makes one tool call per round, then answers. */
function scriptedModel(
  calls: ReadonlyArray<{
    name: string;
    args: unknown;
  }>,
): unknown {
  let round = 0;
  const response = (output: unknown[]): LLMResponse =>
    frameworkCast<LLMResponse>({
      id: `r${round}`,
      status: 'completed',
      output,
      items: [],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
      },
    });
  return {
    callModel: () => ({
      async *getFullResponsesStream() {},
      getResponse: async () => {
        const call = calls[round];
        round += 1;
        if (call) {
          return response([
            {
              id: `fc-${round}`,
              status: 'completed',
              type: 'function_call',
              callId: `call-${round}`,
              name: call.name,
              arguments: JSON.stringify(call.args),
            },
          ]);
        }
        return response([
          {
            id: 'msg',
            status: 'completed',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'done',
              },
            ],
          },
        ]);
      },
    }),
  };
}

/** Collect a turn's events until it ends. */
async function readTurn(stream: AsyncIterable<Emitted>, events: Emitted[]): Promise<void> {
  for await (const event of stream) {
    events.push(event);
    if (/:turn_(completed|aborted)$/.test(event.type)) {
      return;
    }
  }
}

function planEvents(events: Emitted[]): Emitted[] {
  return events.filter((event) => /:plan_(updated|removed)$/.test(event.type));
}

//#endregion

describe("the plan layer's plan, on a callModel step", () => {
  it('is told when the PRD is written and changes, and removed when the plan is cancelled', async () => {
    const harness = new AgentHarness({
      name: 'planner',
      params: {},
      contextLayers: [
        plan(),
      ],
      agentGraph: frameworkCast<
        NonNullable<ConstructorParameters<typeof AgentHarness>[0]['agentGraph']>
      >({
        kind: 'callModel',
        id: 'plan-step',
        model: 'test/model',
      }),
    });
    frameworkCast<{
      llm: {
        client: unknown;
      };
    }>(harness).llm.client = scriptedModel([
      {
        name: 'plan/enterPlanMode',
        args: {},
      },
      {
        name: 'plan/updatePrd',
        args: {
          content: '# Plan\n\n- read the spec',
        },
      },
      // The same PRD again is no change.
      {
        name: 'plan/updatePrd',
        args: {
          content: '# Plan\n\n- read the spec',
        },
      },
      {
        name: 'plan/updatePrd',
        args: {
          content: '# Plan\n\n- read the spec\n- write the code',
        },
      },
      {
        name: 'plan/exitPlanMode',
        args: {
          action: 'cancel',
        },
      },
    ]);
    const events: Emitted[] = [];
    const reading = readTurn(harness.getFullStream(), events);
    await harness.execute('plan it');
    await reading;

    expect(
      planEvents(events).map((event) => [
        event.type,
        event.data.plan,
      ]),
    ).toEqual([
      [
        'planner:plan_updated',
        {
          markdown: '# Plan\n\n- read the spec',
        },
      ],
      [
        'planner:plan_updated',
        {
          markdown: '# Plan\n\n- read the spec\n- write the code',
        },
      ],
      [
        'planner:plan_removed',
        undefined,
      ],
    ]);
  });
});

describe('reportLayerPlans', () => {
  function layerWith(read: ContextLayer['plan']): ContextLayer {
    return frameworkCast<ContextLayer>({
      id: 'tasks',
      slot: 0,
      scope: 'execution',
      hooks: {},
      plan: read,
    });
  }

  it('tells a plan under another id as the old one removed and the new one updated', () => {
    const harness = new AgentHarness({
      name: 'h',
      params: {},
    });
    const ctx = harness.createContext();
    const emitted: Emitted[] = [];
    const emit = (type: string, data: Record<string, unknown>) => {
      emitted.push({
        type,
        data,
      });
    };
    const layer = layerWith((state: unknown) =>
      frameworkCast<{
        id: string;
        entries: [];
      }>(state),
    );
    harness.setLayerState(ctx.id, 'tasks', {
      id: 'a',
      entries: [],
    });
    reportLayerPlans({
      ctx,
      layers: [
        layer,
      ],
      emit,
    });
    harness.setLayerState(ctx.id, 'tasks', {
      id: 'b',
      entries: [],
    });
    reportLayerPlans({
      ctx,
      layers: [
        layer,
      ],
      emit,
    });
    expect(emitted).toEqual([
      {
        type: 'plan_updated',
        data: {
          plan: {
            id: 'a',
            entries: [],
          },
        },
      },
      {
        type: 'plan_removed',
        data: {
          id: 'a',
        },
      },
      {
        type: 'plan_updated',
        data: {
          plan: {
            id: 'b',
            entries: [],
          },
        },
      },
    ]);
  });

  it('tells nothing for a layer with no state, one whose plan throws, or no layers', () => {
    const harness = new AgentHarness({
      name: 'h',
      params: {},
    });
    const ctx = harness.createContext();
    const emitted: string[] = [];
    const emit = (type: string) => {
      emitted.push(type);
    };
    reportLayerPlans({
      ctx,
      layers: undefined,
      emit,
    });
    reportLayerPlans({
      ctx,
      layers: [
        layerWith(() => ({
          entries: [],
        })),
      ],
      emit,
    });
    harness.setLayerState(ctx.id, 'tasks', {});
    reportLayerPlans({
      ctx,
      layers: [
        layerWith(() => {
          throw new Error('unreadable');
        }),
      ],
      emit,
    });
    expect(emitted).toEqual([]);
  });
});
