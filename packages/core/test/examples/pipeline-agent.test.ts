import { describe, expect, it } from 'bun:test';
import { buildPipelineAgent } from '../../examples/pipeline-agent';
import type { CallModelParams } from '../../src/interpreter/execute-llm';
import { InMemoryAgentHarness } from '../../src/runtime/in-memory-agent-harness';
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
    const callModel = createScriptedCallModel([
      textOnlyResponse('SENTIMENT: positive\nTHEMES: AI\nPATTERNS: growth'),
    ]);
    const harness = new InMemoryAgentHarness({
      callModel,
    });
    const ctx = harness.createContext();
    const agent = buildPipelineAgent();

    const result = await harness.run(agent, '  Hello   world!!!  ', ctx);

    expect(result).toContain('=== Text Analysis Report ===');
    expect(result).toContain('=== End Report ===');
  });

  it('normalize stage collapses whitespace before analysis', async () => {
    // The normalize stage collapses whitespace; prepareNext passes its output
    // to the LLM as a user message. We spy on what items the LLM receives.
    let capturedUserText: string | undefined;
    const callModel = (params: CallModelParams) => {
      const userMsg = params.items.findLast(
        (item) => item.type === 'message' && item.role === 'user',
      );
      if (userMsg?.type === 'message') {
        const part = userMsg.content.find((c) => c.type === 'input_text');
        if (part?.type === 'input_text') {
          capturedUserText = part.text;
        }
      }
      return Promise.resolve(textOnlyResponse('SENTIMENT: neutral\nTHEMES: test\nPATTERNS: none'));
    };
    const harness = new InMemoryAgentHarness({
      callModel,
    });
    const ctx = harness.createContext();
    const agent = buildPipelineAgent();

    await harness.run(agent, '  extra   spaces   here  ', ctx);

    // The LLM should have received the normalized text: no leading/trailing
    // spaces and no consecutive internal spaces.
    expect(capturedUserText).toContain('extra spaces here');
    expect(capturedUserText).not.toContain('  ');
  });
});
