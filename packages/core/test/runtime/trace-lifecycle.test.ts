import { describe, expect, it } from 'bun:test';
import { InMemoryExporter } from '../../src/observability/trace-exporter';
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

describe('trace lifecycle via run()', () => {
  it('calls startTrace and completeTrace on success', async () => {
    const exporter = new InMemoryExporter();
    const harness = new AgentHarness({
      name: 'trace-test',
      initialStep: echoStep,
      params: {},
      traceExporter: exporter,
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('ok'),
      ]),
    });

    const ctx = harness.createContext();
    const traceId = ctx.span.traceId; // Capture before run() mutates context
    await harness.run(echoStep, 'hello', ctx);

    expect(exporter.traces).toHaveLength(1);
    expect(exporter.traces[0].traceId).toBe(traceId);
    expect(exporter.traces[0].completed).toBe(true);
    expect(exporter.traces[0].error).toBeUndefined();
  });

  it('calls completeTrace with error on failure', async () => {
    const failStep: Step<ContextMemory, string, string> = {
      kind: 'run',
      id: 'fail',
      execute: async () => {
        throw new Error('step-boom');
      },
    };
    const exporter = new InMemoryExporter();
    const harness = new AgentHarness({
      name: 'trace-test',
      params: {},
      traceExporter: exporter,
      _testCallModel: createScriptedCallModel([]),
    });

    const ctx = harness.createContext();
    await expect(harness.run(failStep, 'hello', ctx)).rejects.toThrow('step-boom');

    expect(exporter.traces).toHaveLength(1);
    expect(exporter.traces[0].completed).toBe(true);
    expect(exporter.traces[0].error?.message).toContain('step-boom');
  });
});
