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

/**
 * A codec that emits one event per newline-terminated statement and buffers the
 * trailing incomplete line — the same shape as the real OpenUI Lang codec. Used
 * to prove the final (unterminated) statement is still emitted.
 */
function makeLineCodec(): OutputCodec<string> & {
  emitted: string[];
} {
  const emitted: string[] = [];
  let buffer = '';
  return {
    emitted,
    kind: 'codec',
    instructions: '',
    start() {
      return {
        push(delta, emit) {
          buffer += delta;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.trim().length === 0) {
              continue;
            }
            emit('openui.node', {
              source: line,
            });
            emitted.push(line);
          }
        },
        finish(fullText) {
          return fullText;
        },
      };
    },
  };
}

describe('executeLLM with an OutputCodec', () => {
  it('emits the trailing statement even when the final line is unterminated', async () => {
    const codec = makeLineCodec();
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'ui',
      model: 'gpt-4',
      output: codec,
    };
    const harness = makeMockHarness();
    // No trailing newline — `root` would stay buffered without the flush fix.
    harness.callModel = async () => makeLLMResponse('bar = Search()\nroot = Card(bar)');
    const ctx = makeMockContext({
      harness,
    });

    await executeLLM(step, 'hi', ctx);
    expect(codec.emitted).toEqual([
      'bar = Search()',
      'root = Card(bar)',
    ]);
  });

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
    // the full assistant text was pushed through the session (newline-terminated
    // so a streaming codec flushes its final statement)
    expect(codec.pushed.join('')).toBe('root = Card("Hi")\n');
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
