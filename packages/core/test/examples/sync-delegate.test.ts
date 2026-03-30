import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { buildSyncDelegateAgent } from '../../examples/sync-delegate';
import { AgentHarness } from '../../src/runtime/agent-harness';
import { createScriptedCallModel, textOnlyResponse, toolCallResponse } from '../_helpers';

describe('sync delegate demo', () => {
  it('agent delegates to sub-agent and returns combined result', async () => {
    // The delegate tool receives the parent context via execute(args, ctx)
    // and forwards it to harness.run, which creates a child context internally
    const harness = new AgentHarness({
      name: 'test',
      params: {},
      _testCallModel: createScriptedCallModel([
        // Step 1: main agent decides to delegate
        toolCallResponse({
          toolName: 'delegate',
          args: '{"task":"What is the capital of France?"}',
          output: '"Paris is the capital of France."',
          finalText: 'I delegated the research.',
        }),
        // Step 2: main agent gives final answer (no tool calls)
        textOnlyResponse('Based on my research, the capital of France is Paris.'),
      ]),
    });

    const agentStep = buildSyncDelegateAgent();

    assert(agentStep.kind === 'loop');
    expect(agentStep.id).toBe('react-loop');
    expect(agentStep.steps[0].kind).toBe('llm');

    const ctx = harness.createContext();
    const result = await harness.run(agentStep, 'What is the capital of France?', ctx);

    expect(result).toBe('Based on my research, the capital of France is Paris.');
  });

  it('buildSyncDelegateAgent creates correct structure', () => {
    const agent = buildSyncDelegateAgent();

    assert(agent.kind === 'loop');
    expect(agent.steps[0].kind).toBe('llm');
  });
});
