import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type { SubHarnessRunContext, SubHarnessStreamPart } from '@noetic-tools/sub-harness';
import { frameworkCast, isSubHarnessStartError } from '@noetic-tools/sub-harness';
import { claudeCode, defaultClaudeCodeRunner, mapClaudeMessage } from '../src/index';

function runContext(): SubHarnessRunContext {
  return frameworkCast<SubHarnessRunContext>({
    cwd: '/tmp',
    threadId: 't1',
  });
}

describe('claudeCode adapter', () => {
  test('builds a claude-code sub-harness with built-in tools', () => {
    const harness = claudeCode();
    expect(harness.harnessId).toBe('claude-code');
    expect(harness.specificationVersion).toBe('harness-v1');
    assert(harness.builtinTools);
    expect(harness.builtinTools.some((t) => t.commonName === 'shell')).toBe(true);
  });

  test('drives an injected runner through a full turn', async () => {
    const fakeRunner = async function* (): AsyncIterable<SubHarnessStreamPart> {
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
    const harness = claudeCode({
      runner: fakeRunner,
      model: 'claude-opus-4-8',
    });
    const session = await harness.doStart({
      settings: {},
      ctx: runContext(),
    });
    expect(session.modelId).toBe('claude-opus-4-8');

    const emitted: SubHarnessStreamPart[] = [];
    const result = await session.doPromptTurn({
      prompt: 'go',
      emit: (p) => emitted.push(p),
    });

    expect(result.text).toBe('all done');
    assert(result.usage);
    expect(result.usage.total).toBe(5);
    expect(result.cost).toBe(0.004);
    expect(result.items).toHaveLength(1);
    // stream-start + 2 deltas + finish forwarded to emit.
    expect(emitted).toHaveLength(4);
  });
});

describe('mapClaudeMessage', () => {
  test('maps assistant text and tool_use blocks', () => {
    const parts = mapClaudeMessage({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'hi',
          },
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'Bash',
            input: {
              cmd: 'ls',
            },
          },
        ],
      },
    });
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      type: 'text-delta',
      delta: 'hi',
    });
    assert(parts[1]?.type === 'tool-call');
    expect(parts[1].toolName).toBe('Bash');
    expect(parts[1].providerExecuted).toBe(true);
  });

  test('maps a successful result to finish with usage and cost', () => {
    const parts = mapClaudeMessage({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
      },
    });
    expect(parts).toHaveLength(1);
    assert(parts[0]?.type === 'finish');
    expect(parts[0].finishReason).toBe('stop');
    expect(parts[0].cost).toBe(0.01);
    assert(parts[0].usage);
    expect(parts[0].usage.input).toBe(100);
  });

  test('maps an error result to an error finish reason', () => {
    const parts = mapClaudeMessage({
      type: 'result',
      subtype: 'error_max_turns',
    });
    assert(parts[0]?.type === 'finish');
    expect(parts[0].finishReason).toBe('error');
  });

  test('falls back to a raw part for unrecognized messages', () => {
    const parts = mapClaudeMessage({
      type: 'system',
      subtype: 'init',
    });
    assert(parts[0]?.type === 'raw');
  });

  test('maps a thinking block to a reasoning delta', () => {
    const parts = mapClaudeMessage({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'thinking',
            thinking: 'let me reason',
          },
        ],
      },
    });
    assert(parts[0]?.type === 'reasoning-delta');
    expect(parts[0].delta).toBe('let me reason');
  });

  test('never drops content: an unknown content block becomes a raw part', () => {
    const parts = mapClaudeMessage({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'image',
            source: {
              data: '…',
            },
          },
        ],
      },
    });
    expect(parts).toHaveLength(1);
    assert(parts[0]?.type === 'raw');
  });
});

describe('defaultClaudeCodeRunner', () => {
  test('throws SubHarnessStartError when the SDK is not installed', async () => {
    const stream = defaultClaudeCodeRunner({
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
      expect(e.harnessId).toBe('claude-code');
    }
  });
});
