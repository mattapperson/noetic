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

/**
 * Judge step + harness caches. A 50-case suite runs the SAME judge (same id,
 * instructions, model) 50 times; rebuilding the step and a fresh harness per
 * call cost an allocation each and — worse — gave every call a fresh context
 * with nothing shared, so provider prompt caches never saw a repeated prefix.
 * One step per (id, model, instructions) and one harness per provider config
 * make every judge call after the first byte-identical up to the case input.
 */
const judgeStepCache = new Map<string, ReturnType<typeof callModel>>();
const judgeHarnessCache = new Map<string, AgentHarness>();

function judgeStepFor(
  id: string,
  model: string,
  instructions: string,
): ReturnType<typeof callModel> {
  const key = `${id}\u0000${model}\u0000${instructions}`;
  let cached = judgeStepCache.get(key);
  if (!cached) {
    cached = callModel({
      id,
      model,
      instructions: `${instructions}\n\nRespond ONLY with valid JSON matching the required schema.`,
    });
    judgeStepCache.set(key, cached);
  }
  return cached;
}

function judgeHarnessFor(callModelDefaults?: LlmProviderConfig): AgentHarness {
  const key = JSON.stringify(callModelDefaults ?? null);
  let cached = judgeHarnessCache.get(key);
  if (!cached) {
    cached = new AgentHarness({
      name: 'llm-judge',
      params: {},
      callModelDefaults,
    });
    judgeHarnessCache.set(key, cached);
  }
  return cached;
}

export async function runJudge<T>(config: JudgeRunConfig<T>): Promise<T> {
  const model = config.judge?.model ?? DEFAULT_MODEL;
  const judgeStep = judgeStepFor(config.id, model, config.instructions);
  const harness = judgeHarnessFor(resolveJudgeProvider(config.judge));
  // A fresh context per call keeps judge invocations independent (no shared
  // history); the shared harness/step give them a stable prompt prefix.
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
