import { describe, expect, it } from 'bun:test';
import { buildPipelineAgent } from '../../examples/pipeline-agent';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createScriptedCallModel, textOnlyResponse } from '../_helpers';

describe('pipeline agent', () => {
  it('buildPipelineAgent creates a loop wrapping a branch', () => {
    const agent = buildPipelineAgent();

    expect(agent.kind).toBe('loop');
    expect(agent.id).toBe('pipeline-loop');
    expect(agent.steps[0].kind).toBe('branch');
    expect(agent.steps[0].id).toBe('phase-router');
  });

  it('runs all three stages and returns the formatted report', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('SENTIMENT: positive\nTHEMES: AI\nPATTERNS: growth'),
      ]),
    });
    const ctx = harness.createContext();
    const agent = buildPipelineAgent();

    const result = await harness.run(agent, '  Hello   world!!!  ', ctx);

    expect(result).toContain('=== Text Analysis Report ===');
    expect(result).toContain('=== End Report ===');
  });

  it('normalize stage collapses whitespace before analysis', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('SENTIMENT: neutral\nTHEMES: test\nPATTERNS: none'),
      ]),
    });
    const ctx = harness.createContext();
    const agent = buildPipelineAgent();

    const result = await harness.run(agent, '  extra   spaces   here  ', ctx);

    // The report should contain the normalized text without extra spaces
    expect(result).toContain('=== Text Analysis Report ===');
  });
});
