import { describe, expect, it } from 'bun:test';
import { agentInbox, buildAsyncDelegateAgent } from '../../examples/async-delegate';
import {
  createScriptedCallModel,
  textOnlyResponse,
  toolCallResponse,
} from '../../examples/helpers';
import { InMemoryRuntime } from '../../src/runtime/in-memory-runtime';

describe('async delegate demo', () => {
  it('buildAsyncDelegateAgent creates loop with inbox and parkTimeout', () => {
    const runtime = new InMemoryRuntime();

    const agent = buildAsyncDelegateAgent({
      runtime,
      inbox: agentInbox,
    });

    expect(agent.kind).toBe('loop');
    expect(agent.id).toBe('async-delegate-loop');
    expect(agent.inbox).toBe(agentInbox);
    expect(agent.parkTimeout).toBe(5e3);
    expect(agent.body.kind).toBe('llm');
  });

  it('agent launches sub-agent, continues, and receives result via inbox', async () => {
    const callModel = createScriptedCallModel([
      // Step 1: launch a sub-agent
      toolCallResponse({
        toolName: 'launch_agent',
        args: '{"task":"research quantum computing"}',
        output: '{"agentId":"sub-1"}',
        finalText: 'I launched a sub-agent to research quantum computing.',
      }),
      // Step 2: no tool calls — agent stops, inbox check happens
      textOnlyResponse('I launched the agent and will wait for results.'),
      // Step 3: after inbox wake, final answer
      textOnlyResponse('Based on the sub-agent results, quantum computing uses qubits.'),
    ]);

    const runtime = new InMemoryRuntime({
      callModel,
    });
    const ctx = runtime.createContext();

    // Pre-load an inbox message to simulate sub-agent completion
    runtime.send(
      agentInbox,
      '[Sub-agent sub-1 completed] Result: Quantum computing uses qubits for computation.',
      ctx,
    );

    const agent = buildAsyncDelegateAgent({
      runtime,
      inbox: agentInbox,
    });
    agent.parkTimeout = 50;

    const result = await runtime.execute(agent, 'Tell me about quantum computing', ctx);

    expect(result).toBe('Based on the sub-agent results, quantum computing uses qubits.');
  });

  it('agentInbox channel has correct configuration', () => {
    expect(agentInbox.name).toBe('agent-inbox');
    expect(agentInbox.mode).toBe('queue');
  });
});
