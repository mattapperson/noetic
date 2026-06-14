import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type { SubHarnessRunContext, SubHarnessStreamPart } from '@noetic-tools/sub-harness';
import { frameworkCast, isSubHarnessStartError } from '@noetic-tools/sub-harness';
import { defaultOpencodeRunner, mapOpencodeMessage, opencode } from '../src/index';

function runContext(): SubHarnessRunContext {
  return frameworkCast<SubHarnessRunContext>({
    cwd: '/tmp',
    threadId: 't1',
  });
}

describe('opencode adapter', () => {
  test('builds an opencode sub-harness with built-in tools', () => {
    const harness = opencode();
    expect(harness.harnessId).toBe('opencode');
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
    const harness = opencode({
      runner: fakeRunner,
      model: 'anthropic/claude-opus-4-8',
    });
    const session = await harness.doStart({
      settings: {},
      ctx: runContext(),
    });
    expect(session.modelId).toBe('anthropic/claude-opus-4-8');

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

describe('mapOpencodeMessage', () => {
  test('maps an assistant message with a text part to a text-delta', () => {
    const parts = mapOpencodeMessage({
      type: 'message',
      part: {
        type: 'text',
        text: 'hi',
      },
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      type: 'text-delta',
      delta: 'hi',
    });
  });

  test('maps a top-level text field to a text-delta', () => {
    const parts = mapOpencodeMessage({
      type: 'assistant',
      text: 'there',
    });
    expect(parts[0]).toEqual({
      type: 'text-delta',
      delta: 'there',
    });
  });

  test('maps a tool invocation to a provider-executed tool-call', () => {
    const parts = mapOpencodeMessage({
      type: 'tool',
      callID: 'tu1',
      tool: 'bash',
      input: {
        cmd: 'ls',
      },
    });
    expect(parts).toHaveLength(1);
    assert(parts[0]?.type === 'tool-call');
    expect(parts[0].toolCallId).toBe('tu1');
    expect(parts[0].toolName).toBe('bash');
    expect(parts[0].providerExecuted).toBe(true);
    expect(parts[0].input).toEqual({
      cmd: 'ls',
    });
  });

  test('maps a session-done event to finish with usage and cost', () => {
    const parts = mapOpencodeMessage({
      type: 'session.idle',
      usage: {
        input: 100,
        output: 20,
      },
      cost: 0.01,
    });
    expect(parts).toHaveLength(1);
    assert(parts[0]?.type === 'finish');
    expect(parts[0].finishReason).toBe('stop');
    expect(parts[0].cost).toBe(0.01);
    assert(parts[0].usage);
    expect(parts[0].usage.input).toBe(100);
    expect(parts[0].usage.output).toBe(20);
  });

  test('maps a session-done event with no usage to finish without usage', () => {
    const parts = mapOpencodeMessage({
      type: 'done',
    });
    assert(parts[0]?.type === 'finish');
    expect(parts[0].usage).toBeUndefined();
  });

  test('falls back to a raw part for unrecognized messages', () => {
    const message = {
      type: 'server.connected',
    };
    const parts = mapOpencodeMessage(message);
    assert(parts[0]?.type === 'raw');
    expect(parts[0].value).toBe(message);
  });
});

describe('defaultOpencodeRunner', () => {
  test('throws SubHarnessStartError when the SDK is not installed', async () => {
    const stream = defaultOpencodeRunner({
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
      expect(e.harnessId).toBe('opencode');
    }
  });
});
