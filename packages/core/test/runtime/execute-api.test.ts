import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { isNoeticConfigError } from '../../src/errors/noetic-config-error';
import { AgentHarness } from '../../src/runtime/agent-harness';
import type { ContextMemory } from '../../src/types/memory';
import type { Step } from '../../src/types/step';
import { createScriptedCallModel, makeMessage, textOnlyResponse } from '../_helpers';

const echoStep: Step<ContextMemory, string, string> = {
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

    await harness.execute('hello');
    const response = await harness.getAgentResponse();
    expect(response.text).toBe('echo: hello');
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

    await harness.execute(item);
    const response = await harness.getAgentResponse();
    expect(response.text).toBe('echo: from item');
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

    await harness.execute(items);
    const response = await harness.getAgentResponse();
    expect(response.text).toBe('echo: second');
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

    await harness.execute('hi', {
      threadId: 'thread-42',
      resourceId: 'user-7',
    });
    const response = await harness.getAgentResponse({
      threadId: 'thread-42',
    });
    expect(response.text).toBe('ok');
  });

  it('rejects with NoeticConfigError when no step is configured', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });

    try {
      await harness.execute('hello');
      expect.unreachable('should have rejected');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('NO_STEP_CONFIGURED');
    }
  });

  it('isolates sessions by threadId', async () => {
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('first'),
        textOnlyResponse('second'),
      ]),
    });

    await harness.execute('alpha', {
      threadId: 't1',
    });
    await harness.execute('beta', {
      threadId: 't2',
    });
    const r1 = await harness.getAgentResponse({
      threadId: 't1',
    });
    const r2 = await harness.getAgentResponse({
      threadId: 't2',
    });
    expect(r1.text).toBe('first');
    expect(r2.text).toBe('second');
  });
});
