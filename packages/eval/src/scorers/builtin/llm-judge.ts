import type { LlmProviderConfig } from '@noetic/core';
import { AgentHarness, step } from '@noetic/core';
import type { ZodType } from 'zod';

//#region Types

export interface JudgeConfig {
  model?: string;
  llm?: LlmProviderConfig;
}

interface JudgeRunConfig<T> {
  id: string;
  system: string;
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
    system: `${config.system}\n\nRespond ONLY with valid JSON matching the required schema.`,
  });

  const harness = new AgentHarness({
    name: 'llm-judge',
    params: {},
    llm: config.judge?.llm,
  });
  const ctx = harness.createContext();

  const raw = await harness.run(judgeStep, config.input, ctx);
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return config.outputSchema.parse(parsed);
}

//#endregion
