import { OpenRouter } from '@openrouter/sdk';
import type { CallModelFn } from '../interpreter/execute-llm';
import { createOpenRouterCallModel } from './openrouter';

//#region Public API

/**
 * Auto-detect a callModel from environment variables.
 * Returns undefined if no OPENROUTER_API_KEY is set.
 *
 * @public
 * @returns A `CallModelFn` backed by OpenRouter, or `undefined` if no API key is found.
 */
export function getDefaultCallModel(): CallModelFn | undefined {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) {
    return undefined;
  }

  const client = new OpenRouter({
    apiKey: openRouterKey,
  });
  return createOpenRouterCallModel(client);
}

//#endregion
