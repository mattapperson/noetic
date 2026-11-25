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
import { LayerPlanReporter, reportingLayerPlans } from '../../src/runtime/layer-plans';

//#region Helpers

interface Emitted {
  type: string;
  data: Record<string, unknown>;
}

/** A model that makes one tool call per round, by its wire name as a real model does, then answers. */
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
        name: 'plan_enterPlanMode',
        args: {},
      },
      {
        name: 'plan_updatePrd',
        args: {
          content: '# Plan\n\n- read the spec',
        },
      },
      // The same PRD again is no change.
      {
        name: 'plan_updatePrd',
        args: {
          content: '# Plan\n\n- read the spec',
        },
      },
      {
        name: 'plan_updatePrd',
        args: {
          content: '# Plan\n\n- read the spec\n- write the code',
        },
      },
      {
        name: 'plan_exitPlanMode',
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

describe('LayerPlanReporter', () => {
  function layerWith(read: ContextLayer['plan']): ContextLayer {
    return frameworkCast<ContextLayer>({
      id: 'tasks',
      slot: 0,
      scope: 'execution',
      hooks: {},
      plan: read,
    });
  }

  function watchedCtx(layers: ContextLayer[]): {
    harness: AgentHarness;
    ctx: ReturnType<AgentHarness['createContext']>;
    emitted: Emitted[];
    reporter: LayerPlanReporter;
  } {
    const harness = new AgentHarness({
      name: 'h',
      params: {},
    });
    const ctx = harness.createContext();
    const emitted: Emitted[] = [];
    Reflect.set(ctx, '_broadcaster', {
      emit(event: Emitted) {
        emitted.push(event);
      },
    });
    const reporter = new LayerPlanReporter();
    reporter.watch(ctx, layers);
    return {
      harness,
      ctx,
      emitted,
      reporter,
    };
  }

  const asPlan = (state: unknown) =>
    frameworkCast<{
      id: string;
      entries: [];
    }>(state);

  it("tells a write to a watched layer's state as it lands, whichever path made it", () => {
    const layer = layerWith(asPlan);
    const { harness, ctx, emitted, reporter } = watchedCtx([
      layer,
    ]);
    const store = reportingLayerPlans(harness.layerStateStore, reporter);
    store.set(ctx.id, 'tasks', {
      id: 'a',
      entries: [],
    });
    expect(
      emitted.map((event) => [
        event.type,
        event.data,
      ]),
    ).toEqual([
      [
        'h:plan_updated',
        {
          plan: {
            id: 'a',
            entries: [],
          },
        },
      ],
    ]);
    // The store underneath has the state.
    expect(harness.layerStateStore.get(ctx.id, 'tasks')).toEqual({
      id: 'a',
      entries: [],
    });
  });

  it('tells a plan under another id as the old one removed and the new one updated, and an unchanged one never', () => {
    const { ctx, emitted, reporter } = watchedCtx([
      layerWith(asPlan),
    ]);
    reporter.changed(ctx.id, 'tasks', {
      id: 'a',
      entries: [],
    });
    reporter.changed(ctx.id, 'tasks', {
      id: 'a',
      entries: [],
    });
    reporter.changed(ctx.id, 'tasks', {
      id: 'b',
      entries: [],
    });
    reporter.changed(ctx.id, 'tasks', undefined);
    expect(
      emitted.map((event) => [
        event.type,
        event.data,
      ]),
    ).toEqual([
      [
        'h:plan_updated',
        {
          plan: {
            id: 'a',
            entries: [],
          },
        },
      ],
      [
        'h:plan_removed',
        {
          id: 'a',
        },
      ],
      [
        'h:plan_updated',
        {
          plan: {
            id: 'b',
            entries: [],
          },
        },
      ],
      [
        'h:plan_removed',
        {
          id: 'b',
        },
      ],
    ]);
  });

  it('tells nothing for an unwatched execution or layer, a layer whose plan throws, or after forget', () => {
    const { ctx, emitted, reporter } = watchedCtx([
      layerWith(() => {
        throw new Error('unreadable');
      }),
    ]);
    reporter.watch(ctx, [
      frameworkCast<ContextLayer>({
        id: 'plain',
        slot: 0,
        scope: 'execution',
        hooks: {},
      }),
    ]);
    reporter.watch(ctx, undefined);
    reporter.changed(ctx.id, 'tasks', {});
    reporter.changed(ctx.id, 'plain', {});
    reporter.changed('elsewhere', 'tasks', {});
    reporter.forget(ctx.id);
    reporter.changed(ctx.id, 'tasks', {});
    expect(emitted).toEqual([]);
  });
});
