import type { LlmProviderConfig } from '@noetic-tools/core';
import { AgentHarness, callModel } from '@noetic-tools/core';
import type { ZodType } from 'zod';

import { resolveEnvLlm } from '../../utils/env-llm';

//#region Types

export interface JudgeConfig {
  model?: string;
  callModel?: LlmProviderConfig;
}

interface JudgeRunConfig<T> {
  id: string;
  instructions: string;
  input: string;
  outputSchema: ZodType<T>;
  judge?: JudgeConfig;
}

//#endregion

//#region Public API

const DEFAULT_MODEL = 'openai/gpt-4o-mini';

/**
 * Pick the LLM provider for a judge run. An explicit `judge.callModel` always
 * wins; otherwise fall back to the environment. Without that fallback an
 * OpenRouter-only environment fails every judge suite with NO_LLM_PROVIDER,
 * because the harness's own default is `provider: 'noetic'`.
 */
export function resolveJudgeProvider(judge?: JudgeConfig): LlmProviderConfig | undefined {
  return judge?.callModel ?? resolveEnvLlm();
}

export async function runJudge<T>(config: JudgeRunConfig<T>): Promise<T> {
  const model = config.judge?.model ?? DEFAULT_MODEL;

  const judgeStep = callModel({
    id: config.id,
    model,
    instructions: `${config.instructions}\n\nRespond ONLY with valid JSON matching the required schema.`,
  });

  const harness = new AgentHarness({
    name: 'llm-judge',
    params: {},
    callModelDefaults: resolveJudgeProvider(config.judge),
  });
  const ctx = harness.createContext();

  const raw = await harness.run(judgeStep, config.input, ctx);

  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error(`LLM judge "${config.id}" returned invalid JSON: ${String(raw).slice(0, 200)}`);
  }
  return config.outputSchema.parse(parsed);
}

//#endregion
