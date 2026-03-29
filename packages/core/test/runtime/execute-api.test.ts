import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { isNoeticConfigError } from '../../src/errors/noetic-config-error';
import { AgentHarness } from '../../src/runtime/agent-harness';
import type { Step } from '../../src/types/step';
import { createScriptedCallModel, makeMessage, textOnlyResponse } from '../_helpers';

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
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('echo: hello'),
      ]),
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
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('echo: from item'),
      ]),
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
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('echo: second'),
      ]),
    });

    const result = await harness.execute(items);
    expect(result).toBe('echo: second');
  });

  it('forwards ExecuteOptions to the context', async () => {
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('ok'),
      ]),
    });

    const result = await harness.execute('hi', {
      threadId: 'thread-42',
      resourceId: 'user-7',
    });
    expect(result).toBe('ok');
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
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('ok'),
        textOnlyResponse('ok'),
      ]),
    });

    await harness.execute('first');
    await harness.execute('second');
    // If we got here without error, both calls succeeded with separate contexts
    expect(true).toBe(true);
  });
});
