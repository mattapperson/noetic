import { describe, expect, it } from 'bun:test';
import {
  createScriptedCallModel,
  textOnlyResponse,
  toolCallResponse,
} from '../../examples/helpers';
import { buildSyncDelegateAgent } from '../../examples/sync-delegate';
import { InMemoryRuntime } from '../../src/runtime/in-memory-runtime';

describe('sync delegate demo', () => {
  it('agent delegates to sub-agent and returns combined result', async () => {
    // Script: main agent calls delegate tool, then sub-agent responds,
    // then main agent gives final answer
    const mainCallModel = createScriptedCallModel([
      // Step 1: main agent decides to delegate
      toolCallResponse({
        toolName: 'delegate',
        args: '{"task":"What is the capital of France?"}',
        output: '"Paris is the capital of France."',
        finalText: 'I delegated the research.',
      }),
      // Step 2: main agent gives final answer (no tool calls)
      textOnlyResponse('Based on my research, the capital of France is Paris.'),
    ]);

    // The delegate tool creates its own runtime context internally,
    // so we test the main agent's behavior with a mocked callModel
    const runtime = new InMemoryRuntime({
      callModel: mainCallModel,
    });

    const agentStep = buildSyncDelegateAgent(runtime);

    expect(agentStep.kind).toBe('loop');
    expect(agentStep.id).toBe('react-loop');
    expect(agentStep.body.kind).toBe('llm');

    const ctx = runtime.createContext();
    const result = await runtime.execute(agentStep, 'What is the capital of France?', ctx);

    expect(result).toBe('Based on my research, the capital of France is Paris.');
  });

  it('buildSyncDelegateAgent creates correct structure', () => {
    const runtime = new InMemoryRuntime();
    const agent = buildSyncDelegateAgent(runtime);

    expect(agent.kind).toBe('loop');
    expect(agent.body.kind).toBe('llm');
  });
});
