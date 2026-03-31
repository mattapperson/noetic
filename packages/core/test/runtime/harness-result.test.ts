import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { isNoeticConfigError } from '../../src/errors/noetic-config-error';
import { AgentHarness } from '../../src/runtime/agent-harness';
import type { ContextMemory } from '../../src/types/memory';
import type { Step } from '../../src/types/step';
import { createScriptedCallModel, textOnlyResponse } from '../_helpers';

const echoStep: Step<ContextMemory, string, string> = {
  kind: 'llm',
  id: 'echo',
  model: 'test/echo',
  tools: [],
};

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iter) {
    items.push(item);
  }
  return items;
}

describe('HarnessResult', () => {
  it('getText() returns the final text output', async () => {
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('hello world'),
      ]),
    });

    const result = harness.execute('hi');
    const text = await result.getText();
    expect(text).toBe('hello world');
  });

  it('getResponse() returns items, usage, and text', async () => {
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('response text'),
      ]),
    });

    const result = harness.execute('hi');
    const response = await result.getResponse();
    expect(response.text).toBe('response text');
    expect(response.items.length).toBeGreaterThan(0);
    expect(response.usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(response.usage.outputTokens).toBeGreaterThanOrEqual(0);
  });

  it('getFullStream() yields framework events for step lifecycle', async () => {
    const harness = new AgentHarness({
      name: 'myagent',
      initialStep: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('streamed'),
      ]),
    });

    const result = harness.execute('hi');
    const events = await collect(result.getFullStream());

    // Should have at least step_started and step_completed framework events
    const frameworkEvents = events.filter((e) => e.source === 'framework');
    const started = frameworkEvents.find((e) => e.type === 'myagent:step_started');
    const completed = frameworkEvents.find((e) => e.type === 'myagent:step_completed');

    assert(started, 'should have step_started event');
    assert(completed, 'should have step_completed event');
    expect(started.data.stepId).toBe('echo');
    expect(started.data.kind).toBe('llm');
  });

  it('error case: getText() rejects when no step configured', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });

    const result = harness.execute('hello');

    try {
      await result.getText();
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('NO_STEP_CONFIGURED');
    }
  });

  it('error case: getResponse() rejects when no step configured', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });

    const result = harness.execute('hello');

    try {
      await result.getResponse();
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('NO_STEP_CONFIGURED');
    }
  });

  it('error case: stream accessors reject when no step configured', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });

    const result = harness.execute('hello');

    try {
      await collect(result.getTextStream());
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      assert(isNoeticConfigError(e));
    }

    try {
      await collect(result.getFullStream());
      expect.unreachable('should have thrown');
    } catch (e2: unknown) {
      assert(isNoeticConfigError(e2));
    }
  });

  it('multiple accessors can be consumed from the same result', async () => {
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('multi'),
      ]),
    });

    const result = harness.execute('hi');
    const [text, response] = await Promise.all([
      result.getText(),
      result.getResponse(),
    ]);

    expect(text).toBe('multi');
    expect(response.text).toBe('multi');
  });
});
