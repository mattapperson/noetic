import { describe, expect, it } from 'bun:test';
import { AgentHarness } from '../../src/harness/agent-harness';
import { GenAI, NoeticAttr } from '../../src/observability/genai-attributes';
import { InMemoryExporter } from '../../src/observability/trace-exporter';
import { parseAndRunWorkflow } from '../../src/patterns/dynamic-workflow';
import { createScriptedCallModel, makeLLMResponse } from '../_helpers';

const WORKFLOW = {
  version: 1,
  root: {
    kind: 'sequence' as const,
    id: 'root',
    steps: [
      {
        kind: 'llm' as const,
        id: 'first',
        model: 'openai/gpt-4o-mini',
        instructions: 'say hi',
      },
      {
        kind: 'llm' as const,
        id: 'second',
        model: 'openai/gpt-4o-mini',
        instructions: 'say bye',
      },
    ],
  },
};

describe('workflow run span (issue #50 follow-up)', () => {
  it('emits a workflow.run span carrying the DAG, parenting model spans', async () => {
    const exporter = new InMemoryExporter();
    const harness = new AgentHarness({
      name: 'repro',
      params: {},
      traceExporter: exporter,
      _testCallModel: createScriptedCallModel([
        makeLLMResponse('hi'),
        makeLLMResponse('bye'),
      ]),
    });
    const ctx = harness.createContext();

    await parseAndRunWorkflow({
      json: WORKFLOW,
      harness,
      ctx,
      tools: [],
      input: 'hello',
    });

    const runSpan = exporter.getSpansByName('workflow.run')[0];
    expect(runSpan).toBeDefined();
    expect(runSpan?.endTime).toBeDefined();

    // The run span carries the full workflow document and a flattened graph.
    const docAttr = runSpan?.attributes.get(NoeticAttr.WORKFLOW_DOCUMENT);
    expect(typeof docAttr).toBe('string');
    expect(JSON.parse(String(docAttr))).toEqual(WORKFLOW);
    expect(runSpan?.attributes.get(NoeticAttr.WORKFLOW_VERSION)).toBe(1);
    // 1 sequence + 2 llm nodes = 3 declared nodes.
    expect(runSpan?.attributes.get(NoeticAttr.WORKFLOW_NODE_COUNT)).toBe(3);

    const nodesAttr = runSpan?.attributes.get(NoeticAttr.WORKFLOW_NODES);
    const nodes = JSON.parse(String(nodesAttr));
    expect(nodes).toContainEqual({
      id: 'first',
      kind: 'llm',
    });
    expect(nodes).toContainEqual({
      id: 'second',
      kind: 'llm',
    });

    // Model-call spans nest under the run span and share its trace.
    const modelSpans = exporter.spans.filter((s) => s.attributes.has(GenAI.REQUEST_MODEL));
    expect(modelSpans.length).toBe(2);
    for (const span of modelSpans) {
      expect(span.traceId).toBe(runSpan?.traceId ?? 'missing');
      expect(span.parentSpanId).toBe(runSpan?.spanId ?? 'missing');
    }

    // Each model span links back to the llm node that drove it (NoeticAttr.NODE_ID),
    // using the same id space as the declared DAG nodes above.
    const nodeIds = modelSpans.map((s) => s.attributes.get(NoeticAttr.NODE_ID));
    expect(nodeIds).toContain('first');
    expect(nodeIds).toContain('second');
  });
});
