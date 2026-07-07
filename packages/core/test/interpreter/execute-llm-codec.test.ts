import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextMemory } from '@noetic-tools/memory';
import type { CallModelRequest, OutputCodec, StepLLM } from '@noetic-tools/types';
import { executeLLM } from '../../src/interpreter/execute-action';
import { makeLLMResponse, makeMockContext, makeMockHarness } from '../_helpers';

/** A tiny codec that upper-cases the text and records the deltas it was fed. */
function makeRecordingCodec(): OutputCodec<string> & {
  pushed: string[];
  events: Array<{
    type: string;
    data: Record<string, unknown>;
  }>;
} {
  const pushed: string[] = [];
  const events: Array<{
    type: string;
    data: Record<string, unknown>;
  }> = [];
  return {
    pushed,
    events,
    kind: 'codec',
    instructions: 'CODEC-INSTRUCTIONS',
    start() {
      return {
        push(delta, emit) {
          pushed.push(delta);
          emit('openui.node', {
            source: delta,
          });
        },
        finish(fullText) {
          return fullText.toUpperCase();
        },
      };
    },
  };
}

describe('executeLLM with an OutputCodec', () => {
  it('folds codec.instructions into the system prompt and keeps the codec off outputSchema', async () => {
    const codec = makeRecordingCodec();
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'ui',
      model: 'gpt-4',
      instructions: 'BASE',
      output: codec,
    };
    let captured: CallModelRequest | undefined;
    const harness = makeMockHarness();
    harness.callModel = async (request) => {
      captured = request;
      return makeLLMResponse('root = Card("Hi")');
    };
    const ctx = makeMockContext({
      harness,
    });

    const result = await executeLLM(step, 'hi', ctx);
    assert(captured !== undefined);
    expect(captured.instructions).toBe('BASE\n\nCODEC-INSTRUCTIONS');
    // codec must NOT be passed as a JSON-schema output format
    expect(captured.outputSchema).toBeUndefined();
    // finish() drives the typed return value
    expect(result).toBe('ROOT = CARD("HI")');
    // the full assistant text was pushed through the session
    expect(codec.pushed.join('')).toBe('root = Card("Hi")');
  });

  it('uses only the codec instructions when the step has none', async () => {
    const codec = makeRecordingCodec();
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'ui',
      model: 'gpt-4',
      output: codec,
    };
    let captured: CallModelRequest | undefined;
    const harness = makeMockHarness();
    harness.callModel = async (request) => {
      captured = request;
      return makeLLMResponse('root = Text("x")');
    };
    const ctx = makeMockContext({
      harness,
    });

    await executeLLM(step, 'hi', ctx);
    assert(captured !== undefined);
    expect(captured.instructions).toBe('CODEC-INSTRUCTIONS');
  });

  it('records usage/meta like any llm step (side-effect invariant)', async () => {
    const codec = makeRecordingCodec();
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'ui',
      model: 'gpt-4',
      output: codec,
    };
    const harness = makeMockHarness();
    harness.callModel = async () => makeLLMResponse('root = Text("x")');
    const ctx = makeMockContext({
      harness,
    });

    await executeLLM(step, 'hi', ctx);
    expect(ctx.lastStepMeta).not.toBeNull();
  });
});
