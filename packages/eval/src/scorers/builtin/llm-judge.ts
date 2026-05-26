import type { LlmProviderConfig } from '@noetic-tools/core';
import { AgentHarness, step } from '@noetic-tools/core';
import type { ZodType } from 'zod';

//#region Types

export interface JudgeConfig {
  model?: string;
  llm?: LlmProviderConfig;
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

export async function runJudge<T>(config: JudgeRunConfig<T>): Promise<T> {
  const model = config.judge?.model ?? DEFAULT_MODEL;

  const judgeStep = step.llm({
    id: config.id,
    model,
    instructions: `${config.instructions}\n\nRespond ONLY with valid JSON matching the required schema.`,
  });

  const harness = new AgentHarness({
    name: 'llm-judge',
    params: {},
    llm: config.judge?.llm,
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
