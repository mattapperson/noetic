/**
 * OpenRouter client factory.
 */

import { OpenRouter } from '@openrouter/agent';

export function createClient(apiKey: string): OpenRouter {
  return new OpenRouter({
    apiKey,
  });
}
