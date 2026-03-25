/**
 * OpenRouter client factory.
 */

import { OpenRouter } from '@openrouter/sdk';

export function createClient(apiKey: string): OpenRouter {
  return new OpenRouter({
    apiKey,
  });
}
