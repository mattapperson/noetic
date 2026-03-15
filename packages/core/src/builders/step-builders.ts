import type { Context } from '../types/context';
import type { RetryPolicy, ModelParams, Tool } from '../types/common';
import type { StepRun, StepLLM, StepTool } from '../types/step';
import type { ZodType } from 'zod';

export const step = {
  run<I, O>(opts: {
    id: string;
    execute: (input: I, ctx: Context) => Promise<O>;
    retry?: RetryPolicy;
  }): StepRun<I, O> {
    return { kind: 'run', ...opts };
  },

  llm<I, O>(opts: {
    id: string;
    model: string;
    system?: string;
    tools?: Tool[];
    output?: ZodType<O>;
    params?: ModelParams;
  }): StepLLM<I, O> {
    return { kind: 'llm', ...opts };
  },

  tool<I, O>(opts: {
    id: string;
    tool: Tool;
    args?: Partial<I>;
  }): StepTool<I, O> {
    return { kind: 'tool', ...opts };
  },
};
