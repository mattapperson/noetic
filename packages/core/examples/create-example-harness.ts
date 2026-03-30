/**
 * Shared harness factory for runnable examples.
 *
 * Creates an AgentHarness wired to a real OpenRouter client,
 * reading the API key from the OPENROUTER_API_KEY environment variable.
 */
import { AgentHarness } from '../src/runtime/agent-harness';

export function createExampleHarness(): AgentHarness {
  return new AgentHarness({
    name: 'test',
    params: {},
    llm: {
      provider: 'openrouter',
    },
  });
}
