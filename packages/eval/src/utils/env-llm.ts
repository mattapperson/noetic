/**
 * Single source of truth for how the eval package picks an LLM provider from
 * the environment. A Noetic platform key wins (matching the harness default of
 * `provider: 'noetic'`); otherwise fall back to direct OpenRouter so suites
 * gated on `OPENROUTER_API_KEY` keep working.
 *
 * API keys are never copied into step or harness config — harness paths let the
 * harness read the key for the selected provider, and the one path that needs a
 * literal key (the GEPA reflection LM, which talks to an SDK outside the
 * harness) receives it directly from here and nowhere else.
 */

import type { LlmProviderConfig } from '@noetic-tools/core';

//#region Constants

/** Mirrors `NOETIC_DEFAULT_BASE_URL` in `@noetic-tools/core`'s harness. */
const NOETIC_DEFAULT_BASE_URL = 'https://platform.noetic.tools/v1';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

//#endregion

//#region Types

/**
 * A resolved OpenAI-wire endpoint for SDKs that bypass the harness. Both the
 * Noetic platform and OpenRouter speak the same wire protocol and accept the
 * same `vendor/model` slugs, so one shape covers either provider.
 */
export interface EnvLlmCredentials {
  provider: 'noetic' | 'openrouter';
  apiKey: string;
  apiURL: string;
}

//#endregion

//#region Public API

/**
 * Resolve the harness LLM provider from the environment for `callModelDefaults`.
 * Returns `undefined` when a Noetic key is present (the harness already defaults
 * to `provider: 'noetic'`) and when no key is present at all — in both cases the
 * harness's own resolution is correct and must not be overridden.
 */
export function resolveEnvLlm(): LlmProviderConfig | undefined {
  if (process.env.NOETIC_API_KEY) {
    return undefined;
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      provider: 'openrouter',
    };
  }
  return undefined;
}

/**
 * Resolve an explicit key + base URL for code paths that call an LLM through a
 * third-party SDK rather than the harness. Returns `undefined` when neither
 * `NOETIC_API_KEY` nor `OPENROUTER_API_KEY` is set, which callers treat as
 * "no LLM available — take the offline path".
 */
export function resolveEnvLlmCredentials(): EnvLlmCredentials | undefined {
  const noeticApiKey = process.env.NOETIC_API_KEY;
  if (noeticApiKey) {
    return {
      provider: 'noetic',
      apiKey: noeticApiKey,
      apiURL: process.env.NOETIC_BASE_URL ?? NOETIC_DEFAULT_BASE_URL,
    };
  }
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  if (openrouterApiKey) {
    return {
      provider: 'openrouter',
      apiKey: openrouterApiKey,
      apiURL: OPENROUTER_BASE_URL,
    };
  }
  return undefined;
}

//#endregion
