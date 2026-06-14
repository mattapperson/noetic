import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type { SubHarnessRunContext, SubHarnessStreamPart } from '@noetic-tools/sub-harness';
import { frameworkCast, isSubHarnessStartError } from '@noetic-tools/sub-harness';
import { defaultPiRunner, mapPiMessage, pi } from '../src/index';

function runContext(): SubHarnessRunContext {
  return frameworkCast<SubHarnessRunContext>({
    cwd: '/tmp',
    threadId: 't1',
  });
}

describe('pi adapter', () => {
  test('builds a pi sub-harness with built-in tools', () => {
    const harness = pi();
    expect(harness.harnessId).toBe('pi');
    expect(harness.specificationVersion).toBe('harness-v1');
    assert(harness.builtinTools);
    expect(harness.builtinTools.some((t) => t.commonName === 'shell')).toBe(true);
  });

  test('drives an injected runner through a full turn', async () => {
    const fakeRunner = async function* (): AsyncIterable<SubHarnessStreamPart> {
      yield {
        type: 'reasoning-delta',
        delta: 'mulling it over',
      };
      yield {
        type: 'text-delta',
        delta: 'all ',
      };
      yield {
        type: 'text-delta',
        delta: 'done',
      };
      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: {
          input: 3,
          output: 2,
        },
        cost: 0.004,
      };
    };
    const harness = pi({
      runner: fakeRunner,
      model: 'pi-1',
    });
    const session = await harness.doStart({
      settings: {},
      ctx: runContext(),
    });
    expect(session.modelId).toBe('pi-1');

    const emitted: SubHarnessStreamPart[] = [];
    const result = await session.doPromptTurn({
      prompt: 'go',
      emit: (p) => emitted.push(p),
    });

    expect(result.text).toBe('all done');
    assert(result.usage);
    expect(result.usage.total).toBe(5);
    expect(result.cost).toBe(0.004);
    // Reasoning does not produce an item; only the assistant message does.
    expect(result.items).toHaveLength(1);
    // stream-start + reasoning-delta + 2 text-deltas + finish forwarded to emit.
    expect(emitted).toHaveLength(5);
    expect(emitted.some((p) => p.type === 'reasoning-delta')).toBe(true);
  });
});

describe('mapPiMessage', () => {
  test('maps assistant text from text and delta fields', () => {
    expect(
      mapPiMessage({
        type: 'text',
        text: 'hi',
      }),
    ).toEqual([
      {
        type: 'text-delta',
        delta: 'hi',
      },
    ]);
    expect(
      mapPiMessage({
        type: 'assistant',
        delta: 'yo',
      }),
    ).toEqual([
      {
        type: 'text-delta',
        delta: 'yo',
      },
    ]);
  });

  test('maps reasoning/thinking to a reasoning delta', () => {
    const parts = mapPiMessage({
      type: 'thinking',
      text: 'hmm',
    });
    assert(parts[0]?.type === 'reasoning-delta');
    expect(parts[0].delta).toBe('hmm');
  });

  test('maps a tool call with arguments and callId fallbacks', () => {
    const parts = mapPiMessage({
      type: 'tool_call',
      callId: 'tc1',
      name: 'bash',
      arguments: {
        cmd: 'ls',
      },
    });
    assert(parts[0]?.type === 'tool-call');
    expect(parts[0].toolCallId).toBe('tc1');
    expect(parts[0].toolName).toBe('bash');
    expect(parts[0].input).toEqual({
      cmd: 'ls',
    });
    expect(parts[0].providerExecuted).toBe(true);
  });

  test('maps a terminal event to a stop finish with usage and cost', () => {
    const parts = mapPiMessage({
      type: 'done',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
      },
      cost: 0.01,
    });
    assert(parts[0]?.type === 'finish');
    expect(parts[0].finishReason).toBe('stop');
    expect(parts[0].cost).toBe(0.01);
    assert(parts[0].usage);
    expect(parts[0].usage.input).toBe(100);
    expect(parts[0].usage.output).toBe(20);
  });

  test('maps a terminal event with an error to an error finish', () => {
    const parts = mapPiMessage({
      type: 'result',
      error: 'boom',
    });
    assert(parts[0]?.type === 'finish');
    expect(parts[0].finishReason).toBe('error');
  });

  test('falls back to a raw part for unrecognized messages', () => {
    const parts = mapPiMessage({
      type: 'system',
      subtype: 'init',
    });
    assert(parts[0]?.type === 'raw');
    expect(parts[0].value).toEqual({
      type: 'system',
      subtype: 'init',
    });
  });
});

describe('defaultPiRunner', () => {
  test('throws SubHarnessStartError when the SDK is not installed', async () => {
    const stream = defaultPiRunner({
      prompt: 'go',
      ctx: runContext(),
      history: [],
      settings: {},
    });
    try {
      for await (const _part of stream) {
        // The SDK module is not a dependency here, so iteration must throw.
      }
      throw new Error('expected throw');
    } catch (e) {
      assert(isSubHarnessStartError(e));
      expect(e.harnessId).toBe('pi');
    }
  });
});
