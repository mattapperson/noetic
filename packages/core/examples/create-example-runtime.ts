/**
 * Shared runtime factory for runnable examples.
 *
 * Creates an InMemoryRuntime wired to a real OpenRouter client,
 * reading the API key from the OPENROUTER_API_KEY environment variable.
 */
import { OpenRouter } from '@openrouter/sdk';
import { createOpenRouterCallModel } from '../src/adapters/openrouter';
import { InMemoryRuntime } from '../src/runtime/in-memory-runtime';

export function createExampleRuntime(): InMemoryRuntime {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY environment variable is required');
  }
  const client = new OpenRouter({
    apiKey,
  });
  const callModel = createOpenRouterCallModel(client);
  return new InMemoryRuntime({
    callModel,
  });
}
