/**
 * Shared harness factory for runnable examples.
 *
 * Creates an InMemoryAgentHarness wired to a real OpenRouter client,
 * reading the API key from the OPENROUTER_API_KEY environment variable.
 */
import { OpenRouter } from '@openrouter/sdk';
import { createOpenRouterCallModel } from '../src/adapters/openrouter';
import { InMemoryAgentHarness } from '../src/runtime/in-memory-agent-harness';

export function createExampleHarness(): InMemoryAgentHarness {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY environment variable is required');
  }
  const client = new OpenRouter({
    apiKey,
  });
  const callModel = createOpenRouterCallModel(client);
  return new InMemoryAgentHarness({
    name: 'test',
    params: {},
    callModel,
  });
}
