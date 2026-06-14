import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type { SubHarness, SubHarnessRunContext, SubHarnessStreamPart } from '@noetic-tools/types';
import { createMessage } from '@noetic-tools/types';
import {
  assistantMessageItem,
  commonTool,
  createSubHarnessRegistry,
  defineSubHarness,
  formatConversation,
  frameworkCast,
  functionCallItem,
  isSubHarnessCapabilityError,
  isSubHarnessStartError,
  SUB_HARNESS_KINDS,
  SubHarnessCapabilityError,
  SubHarnessStartError,
  SubHarnessStreamPartSchema,
  SubHarnessTurnAccumulator,
  withHistoryPrompt,
} from '../src/index';

describe('item builders', () => {
  test('assistantMessageItem carries the text in an output_text part', () => {
    const item = assistantMessageItem('hello');
    assert(item.type === 'message');
    assert(item.role === 'assistant');
    const part = item.content[0];
    assert(part.type === 'output_text');
    expect(part.text).toBe('hello');
  });

  test('functionCallItem serialises object input as JSON arguments', () => {
    const item = functionCallItem({
      name: 'bash',
      input: {
        cmd: 'ls',
      },
    });
    assert(item.type === 'function_call');
    expect(item.name).toBe('bash');
    expect(item.arguments).toBe('{"cmd":"ls"}');
    expect(item.callId).toMatch(/^call-/);
  });

  test('functionCallItem passes through string input unchanged', () => {
    const item = functionCallItem({
      name: 'bash',
      input: 'raw',
      callId: 'c1',
    });
    assert(item.type === 'function_call');
    expect(item.arguments).toBe('raw');
    expect(item.callId).toBe('c1');
  });
});

describe('SubHarnessTurnAccumulator', () => {
  test('accumulates text + tool calls into items and forwards to emit', () => {
    const seen: SubHarnessStreamPart[] = [];
    const acc = new SubHarnessTurnAccumulator({
      emit: (p) => seen.push(p),
    });
    acc.push({
      type: 'stream-start',
    });
    acc.push({
      type: 'text-delta',
      delta: 'Hello ',
    });
    acc.push({
      type: 'text-delta',
      delta: 'world',
    });
    acc.push({
      type: 'tool-call',
      toolCallId: 't1',
      toolName: 'bash',
      input: {
        cmd: 'ls',
      },
    });
    acc.push({
      type: 'finish',
      finishReason: 'stop',
      usage: {
        input: 10,
        output: 5,
      },
    });

    expect(seen).toHaveLength(5);
    const result = acc.result();
    expect(result.text).toBe('Hello world');
    // assistant message + one tool-call item
    expect(result.items).toHaveLength(2);
    expect(result.finishReason).toBe('stop');
    assert(result.usage);
    // total is derived when the stream omits it
    expect(result.usage.total).toBe(15);
  });

  test('emits no assistant item when there is no text', () => {
    const acc = new SubHarnessTurnAccumulator();
    acc.push({
      type: 'finish',
      finishReason: 'stop',
    });
    const result = acc.result();
    expect(result.items).toHaveLength(0);
    expect(result.text).toBe('');
  });

  test('result overrides win over stream-reported usage', () => {
    const acc = new SubHarnessTurnAccumulator();
    acc.push({
      type: 'text-delta',
      delta: 'hi',
    });
    acc.push({
      type: 'finish',
      finishReason: 'stop',
      usage: {
        input: 1,
        output: 1,
        total: 2,
      },
    });
    const result = acc.result({
      usage: {
        input: 9,
        output: 9,
        total: 18,
      },
      cost: 0.01,
    });
    assert(result.usage);
    expect(result.usage.total).toBe(18);
    expect(result.cost).toBe(0.01);
  });
});

describe('registry', () => {
  function fake(harnessId: SubHarness['harnessId']): SubHarness {
    return {
      specificationVersion: 'harness-v1',
      harnessId,
      async doStart() {
        return {
          sessionId: 's',
          isResume: false,
          async doPromptTurn() {
            return {
              items: [],
              text: '',
            };
          },
          async doStop() {
            return {
              harnessId,
              sessionId: 's',
              state: null,
            };
          },
        };
      },
    };
  }

  test('keys adapters by harnessId', () => {
    const registry = createSubHarnessRegistry(fake('claude-code'), fake('codex'));
    expect(registry.get('claude-code')?.harnessId).toBe('claude-code');
    expect(registry.get('codex')?.harnessId).toBe('codex');
    expect(registry.get('pi')).toBeUndefined();
  });
});

describe('common tool vocabulary', () => {
  test('commonTool builds a builtin tool descriptor', () => {
    const t = commonTool('Bash', 'shell', 'run a command');
    expect(t.nativeName).toBe('Bash');
    expect(t.commonName).toBe('shell');
  });
});

describe('errors', () => {
  test('SubHarnessCapabilityError is guarded and carries the capability', () => {
    const e = new SubHarnessCapabilityError({
      harnessId: 'codex',
      capability: 'doCompact',
    });
    assert(isSubHarnessCapabilityError(e));
    expect(e.capability).toBe('doCompact');
    expect(isSubHarnessStartError(e)).toBe(false);
  });

  test('SubHarnessStartError is guarded and carries the cause', () => {
    const cause = new Error('CLI missing');
    const e = new SubHarnessStartError({
      harnessId: 'pi',
      message: 'failed',
      cause,
    });
    assert(isSubHarnessStartError(e));
    expect(e.startCause).toBe(cause);
  });
});

describe('stream part schema', () => {
  test('validates a well-formed tool-call part', () => {
    const parsed = SubHarnessStreamPartSchema.safeParse({
      type: 'tool-call',
      toolCallId: 't1',
      toolName: 'bash',
      input: {
        cmd: 'ls',
      },
    });
    expect(parsed.success).toBe(true);
  });

  test('rejects an unknown part type', () => {
    const parsed = SubHarnessStreamPartSchema.safeParse({
      type: 'nope',
    });
    expect(parsed.success).toBe(false);
  });

  test('SUB_HARNESS_KINDS lists every harness kind', () => {
    expect(
      [
        ...SUB_HARNESS_KINDS,
      ].sort(),
    ).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'pi',
    ]);
  });
});

describe('formatConversation / withHistoryPrompt', () => {
  test('renders a role-labelled transcript', () => {
    const out = formatConversation([
      createMessage('hello there', 'user'),
      assistantMessageItem('hi, how can I help?'),
    ]);
    expect(out).toContain('User: hello there');
    expect(out).toContain('Assistant: hi, how can I help?');
  });

  test('withHistoryPrompt returns the prompt unchanged when there is no history', () => {
    expect(
      withHistoryPrompt({
        prompt: 'go',
        history: [],
      }),
    ).toBe('go');
  });

  test('withHistoryPrompt prepends the conversation to the prompt', () => {
    const out = withHistoryPrompt({
      prompt: 'continue the task',
      history: [
        createMessage('remember the API key is in env', 'user'),
      ],
    });
    expect(out).toContain('remember the API key is in env');
    expect(out).toContain('continue the task');
  });
});

describe('defineSubHarness — history seeding', () => {
  function ctx(): SubHarnessRunContext {
    return frameworkCast<SubHarnessRunContext>({
      cwd: '/tmp',
      threadId: 't',
    });
  }

  test('passes history to the runner on the first turn only', async () => {
    const seen: number[] = [];
    const harness = defineSubHarness({
      harnessId: 'pi',
      runner: async function* (input) {
        seen.push(input.history.length);
        yield {
          type: 'finish',
          finishReason: 'stop',
        };
      },
    });
    const history = [
      createMessage('prior turn', 'user'),
      assistantMessageItem('prior reply'),
    ];
    const session = await harness.doStart({
      history,
      ctx: ctx(),
    });
    await session.doPromptTurn({
      prompt: 'a',
      emit: () => {},
    });
    await session.doPromptTurn({
      prompt: 'b',
      emit: () => {},
    });
    // First turn is seeded with the 2 history items; the session owns history after that.
    expect(seen).toEqual([
      2,
      0,
    ]);
  });
});
