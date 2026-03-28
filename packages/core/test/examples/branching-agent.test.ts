import { describe, expect, it } from 'bun:test';
import { buildBranchingAgent } from '../../examples/branching-agent';
import { InMemoryAgentHarness } from '../../src/runtime/in-memory-agent-harness';
import { createScriptedCallModel, textOnlyResponse } from '../_helpers';

describe('branching agent', () => {
  it('buildBranchingAgent creates a loop wrapping a branch', () => {
    const agent = buildBranchingAgent();

    expect(agent.kind).toBe('loop');
    expect(agent.id).toBe('ticket-processing-loop');
    expect(agent.steps[0].kind).toBe('branch');
    expect(agent.steps[0].id).toBe('ticket-router');
  });

  it('routes billing keywords to deterministic handler', async () => {
    const harness = new InMemoryAgentHarness({
      name: 'test',
      params: {},
    });
    const ctx = harness.createContext();
    const agent = buildBranchingAgent();

    const result = await harness.run(agent, 'I was charged twice on my invoice', ctx);

    expect(result).toContain('Billing Support Response:');
    expect(result).toContain('/billing');
  });

  it('routes technical keywords to llm handler', async () => {
    const callModel = createScriptedCallModel([
      textOnlyResponse('Try clearing your cache and restarting.'),
    ]);
    const harness = new InMemoryAgentHarness({
      name: 'test',
      params: {},
      callModel,
    });
    const ctx = harness.createContext();
    const agent = buildBranchingAgent();

    const result = await harness.run(agent, 'My app keeps crashing with an error', ctx);

    expect(result).toBe('Try clearing your cache and restarting.');
  });

  it('routes unrecognized input to fallback handler', async () => {
    const harness = new InMemoryAgentHarness({
      name: 'test',
      params: {},
    });
    const ctx = harness.createContext();
    const agent = buildBranchingAgent();

    const result = await harness.run(agent, 'Hello, I have a general question', ctx);

    expect(result).toContain('General Support Response:');
    expect(result).toContain('48 hours');
  });
});
