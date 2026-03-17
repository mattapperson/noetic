import type { CallModelFn } from '@noetic/core';
import { step as coreStep, InMemoryRuntime } from '@noetic/core';
import type { ZodType } from 'zod';

//#region Types

export interface JudgeConfig {
  model?: string;
  callModel?: CallModelFn;
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

  const judgeStep = coreStep.llm({
    id: config.id,
    model,
    system: `${config.system}\n\nRespond ONLY with valid JSON matching the required schema.`,
  });

  const runtime = new InMemoryRuntime({
    callModel: config.judge?.callModel,
  });
  const ctx = runtime.createContext();

  const raw = await runtime.execute(judgeStep, config.input, ctx);
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return config.outputSchema.parse(parsed);
}

//#endregion
