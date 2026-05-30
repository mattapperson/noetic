/**
 * Core smoke surface. Imports **only** `@noetic-tools/core`, which is fully
 * platform-portable (it reaches OpenRouter via `fetch`, with no `node:` builtins
 * referenced at module load). Kept separate from the code-agent smoke so core's
 * portable surface is exercised independently.
 */

import { AgentHarness, step } from '@noetic-tools/core';

import type { CoreSmokeResult } from './types.js';

export const DEFAULT_MODEL = 'openai/gpt-4o-mini';
export const PING_INSTRUCTIONS =
  'You are a smoke-test responder. Reply with exactly one short word and nothing else.';
export const PING_PROMPT = 'Reply with the single word: PONG';

/** Assert a value is a non-empty string and return it trimmed. */
export function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} did not return a non-empty string (got ${typeof value})`);
  }
  return value.trim();
}

/** Run a live OpenRouter `step.llm` through the core `AgentHarness`. */
export async function runCoreSmoke(apiKey: string, model: string): Promise<CoreSmokeResult> {
  const llmStep = step.llm({
    id: 'compat-core-ping',
    model,
    instructions: PING_INSTRUCTIONS,
  });

  const harness = new AgentHarness({
    name: 'compat-core-smoke',
    params: {},
    llm: {
      provider: 'openrouter',
      apiKey,
    },
  });

  const ctx = harness.createContext();
  const result = await harness.run(llmStep, PING_PROMPT, ctx);

  return {
    reply: asNonEmptyString(result, 'core step.llm'),
    inputTokens: ctx.tokens.input,
    outputTokens: ctx.tokens.output,
  };
}
