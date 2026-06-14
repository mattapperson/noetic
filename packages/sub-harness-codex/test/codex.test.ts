import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type { SubHarnessRunContext, SubHarnessStreamPart } from '@noetic-tools/sub-harness';
import { frameworkCast, isSubHarnessStartError } from '@noetic-tools/sub-harness';
import { codex, defaultCodexRunner, mapCodexMessage } from '../src/index';

function runContext(): SubHarnessRunContext {
  return frameworkCast<SubHarnessRunContext>({
    cwd: '/tmp',
    threadId: 't1',
  });
}

describe('codex adapter', () => {
  test('builds a codex sub-harness with built-in tools', () => {
    const harness = codex();
    expect(harness.harnessId).toBe('codex');
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
    const harness = codex({
      runner: fakeRunner,
      model: 'gpt-5.3-codex',
    });
    const session = await harness.doStart({
      settings: {},
      ctx: runContext(),
    });
    expect(session.modelId).toBe('gpt-5.3-codex');

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
    assert(emitted[0]?.type === 'stream-start');
  });
});

describe('mapCodexMessage', () => {
  test('maps an assistant text event to a text-delta', () => {
    const parts = mapCodexMessage({
      type: 'agent_message',
      text: 'hi',
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      type: 'text-delta',
      delta: 'hi',
    });
  });

  test('maps a command event to a provider-executed tool-call', () => {
    const parts = mapCodexMessage({
      type: 'command',
      id: 'tc1',
      command: 'shell',
      input: {
        cmd: 'ls',
      },
    });
    expect(parts).toHaveLength(1);
    assert(parts[0]?.type === 'tool-call');
    expect(parts[0].toolCallId).toBe('tc1');
    expect(parts[0].toolName).toBe('shell');
    expect(parts[0].providerExecuted).toBe(true);
  });

  test('maps a completed turn to a stop finish with usage and cost', () => {
    const parts = mapCodexMessage({
      type: 'turn.completed',
      status: 'completed',
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

  test('maps a failed turn to an error finish reason', () => {
    const parts = mapCodexMessage({
      type: 'turn.completed',
      status: 'failed',
    });
    assert(parts[0]?.type === 'finish');
    expect(parts[0].finishReason).toBe('error');
  });

  test('falls back to a raw part for unrecognized messages', () => {
    const parts = mapCodexMessage({
      type: 'session.created',
      id: 's1',
    });
    assert(parts[0]?.type === 'raw');
  });
});

describe('defaultCodexRunner', () => {
  test('throws SubHarnessStartError when the SDK is not installed', async () => {
    const stream = defaultCodexRunner({
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
      expect(e.harnessId).toBe('codex');
    }
  });
});
