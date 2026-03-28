import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { isNoeticConfigError } from '../../src/errors/noetic-config-error';
import type { CallModelFn } from '../../src/interpreter/execute-llm';
import { AgentHarness } from '../../src/runtime/agent-harness';
import type { Step } from '../../src/types/step';
import { makeMessage, textOnlyResponse } from '../_helpers';

const echoCallModel: CallModelFn = async ({ items }) => {
  const lastUserMsg = [
    ...items,
  ]
    .reverse()
    .find((i) => i.type === 'message' && i.role === 'user');
  const text =
    lastUserMsg?.type === 'message'
      ? lastUserMsg.content
          .filter((c) => c.type === 'input_text')
          .map((c) => c.text)
          .join('')
      : 'no input';
  return textOnlyResponse(`echo: ${text}`);
};

const echoStep: Step<string, string> = {
  kind: 'llm',
  id: 'echo',
  model: 'test/echo',
  tools: [],
};

describe('AgentHarness.execute()', () => {
  it('accepts a string input and returns the agent output', async () => {
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      callModel: echoCallModel,
    });

    const result = await harness.execute('hello');
    expect(result).toBe('echo: hello');
  });

  it('accepts a single Item input', async () => {
    const item = makeMessage('user', 'from item', 'msg-1');

    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      callModel: echoCallModel,
    });

    const result = await harness.execute(item);
    expect(result).toBe('echo: from item');
  });

  it('accepts an array of Items', async () => {
    const items = [
      makeMessage('user', 'first', 'msg-1'),
      makeMessage('user', 'second', 'msg-2'),
    ];

    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      callModel: echoCallModel,
    });

    const result = await harness.execute(items);
    expect(result).toBe('echo: second');
  });

  it('forwards ExecuteOptions to the context', async () => {
    let capturedThreadId: string | undefined;
    const callModel: CallModelFn = async ({ ctx }) => {
      capturedThreadId = ctx.threadId;
      return textOnlyResponse('ok');
    };

    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      callModel,
    });

    await harness.execute('hi', {
      threadId: 'thread-42',
      resourceId: 'user-7',
    });
    assert(capturedThreadId !== undefined);
    expect(capturedThreadId).toBe('thread-42');
  });

  it('throws NoeticConfigError when no step is configured', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });

    try {
      await harness.execute('hello');
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('NO_STEP_CONFIGURED');
    }
  });

  it('creates a fresh context per execute() call (no state leakage)', async () => {
    const contextIds: string[] = [];
    const callModel: CallModelFn = async ({ ctx }) => {
      contextIds.push(ctx.id);
      return textOnlyResponse('ok');
    };

    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      callModel,
    });

    await harness.execute('first');
    await harness.execute('second');
    expect(contextIds).toHaveLength(2);
    assert(contextIds[0] !== undefined);
    assert(contextIds[1] !== undefined);
    expect(contextIds[0]).not.toBe(contextIds[1]);
  });
});
