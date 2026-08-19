/**
 * `ExecuteOptions.extraContextLayers` appends per-turn layers to the harness's
 * effective layer set — it must never replace it, unlike `contextLayers`,
 * whose override semantics silently deleted a served harness's instructions/
 * history/steering when the ACP server injected its permission gate.
 *
 * Also covers `turn_aborted.errorKind`: the typed NoeticError kind rides on
 * the event so consumers (the ACP server's stop-reason mapping) can classify
 * an abort without parsing the human-readable message.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import type { ContextLayer, Step, StreamEvent } from '@noetic-tools/types';
import { frameworkCast, NoeticErrorImpl } from '@noetic-tools/types';
import { AgentHarness } from '../../src/harness/agent-harness';
import { textOnlyResponse } from '../_helpers';

function recordingLayer(id: string, initialized: string[]): ContextLayer {
  return frameworkCast<ContextLayer>({
    id,
    slot: 10,
    scope: 'execution',
    hooks: {
      init: async () => {
        initialized.push(id);
        return {
          state: {},
        };
      },
    },
  });
}

const okStep: Step<ContextData, string, string> = {
  kind: 'callModel',
  id: 'ok',
  model: 'test/echo',
  tools: [],
};

async function drain(harness: AgentHarness<Record<string, never>>): Promise<void> {
  await harness.getAgentResponse();
}

describe('ExecuteOptions.extraContextLayers', () => {
  it('appends to harness-level layers instead of replacing them', async () => {
    const initialized: string[] = [];
    const harness = new AgentHarness({
      name: 'extras',
      agentGraph: okStep,
      params: {},
      contextLayers: [
        recordingLayer('harness-layer', initialized),
      ],
      _testCallModel: async () => textOnlyResponse('ok'),
    });

    await harness.execute('hello', {
      extraContextLayers: [
        recordingLayer('turn-gate', initialized),
      ],
    });
    await drain(harness);

    expect(initialized).toContain('harness-layer');
    expect(initialized).toContain('turn-gate');
  });

  it('composes with a contextLayers override: override base plus extras', async () => {
    const initialized: string[] = [];
    const harness = new AgentHarness({
      name: 'extras',
      agentGraph: okStep,
      params: {},
      contextLayers: [
        recordingLayer('harness-layer', initialized),
      ],
      _testCallModel: async () => textOnlyResponse('ok'),
    });

    await harness.execute('hello', {
      contextLayers: [
        recordingLayer('override-layer', initialized),
      ],
      extraContextLayers: [
        recordingLayer('turn-gate', initialized),
      ],
    });
    await drain(harness);

    expect(initialized).toContain('override-layer');
    expect(initialized).toContain('turn-gate');
    expect(initialized).not.toContain('harness-layer');
  });
});

describe('turn_aborted carries errorKind', () => {
  it('a NoeticError abort surfaces its typed kind on the event', async () => {
    const failingStep: Step<ContextData, string, string> = frameworkCast<
      Step<ContextData, string, string>
    >({
      kind: 'runCode',
      id: 'refuse',
      execute: async () => {
        throw new NoeticErrorImpl({
          kind: 'model_refused',
          stepId: 'refuse',
          refusal: 'no thanks',
        });
      },
    });
    const harness = new AgentHarness({
      name: 'extras',
      agentGraph: failingStep,
      params: {},
    });

    const iterator = harness.getFullStream()[Symbol.asyncIterator]();
    const events: AsyncIterable<StreamEvent> = {
      [Symbol.asyncIterator]: () => iterator,
    };
    await harness.execute('hello');

    let aborted: StreamEvent | undefined;
    for await (const event of events) {
      if (event.source === 'framework' && event.type.endsWith(':turn_aborted')) {
        aborted = event;
        break;
      }
    }
    assert(aborted);
    // The runCode executor wraps the thrown error as step_failed — the point
    // here is that the TYPED kind rides the event at all; interpreter paths
    // that throw model_refused/cancelled directly surface those kinds.
    expect(aborted.data.errorKind).toBe('step_failed');
    expect(typeof aborted.data.reason).toBe('string');
  });
});

describe('turn_aborted on a real cancellation', () => {
  it('carries errorKind cancelled when the session is aborted mid-turn', async () => {
    const { channel } = await import('../../src/builders/channel-builder');
    const { z } = await import('zod');
    const hang = channel('extra-layers-hang', {
      schema: z.string(),
      mode: 'queue',
    });
    const hangingStep: Step<ContextData, string, string> = frameworkCast<
      Step<ContextData, string, string>
    >({
      kind: 'runCode',
      id: 'hang',
      execute: async (
        _input: string,
        ctx: {
          recv: (c: unknown, o: unknown) => Promise<string>;
        },
      ) =>
        ctx.recv(hang, {
          timeout: 60_000,
        }),
    });
    const harness = new AgentHarness({
      name: 'extras',
      agentGraph: hangingStep,
      params: {},
    });

    const iterator = harness.getFullStream()[Symbol.asyncIterator]();
    const events: AsyncIterable<StreamEvent> = {
      [Symbol.asyncIterator]: () => iterator,
    };
    await harness.execute('hang forever');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await harness.abort({
      reason: 'user pressed stop',
    });

    let aborted: StreamEvent | undefined;
    for await (const event of events) {
      if (event.source === 'framework' && event.type.endsWith(':turn_aborted')) {
        aborted = event;
        break;
      }
    }
    assert(aborted);
    // The typed kind comes from the cancelled NoeticError the abort produced —
    // this is the chain the ACP server's stop-reason mapping rides.
    expect(aborted.data.errorKind).toBe('cancelled');
  });
});
