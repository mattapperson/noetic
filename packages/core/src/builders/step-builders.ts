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
    if (!opts.id || opts.id.trim() === '') throw new Error('step.run requires a non-empty id');
    if (!opts.execute) throw new Error('step.run requires an execute function');
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
    if (!opts.id || opts.id.trim() === '') throw new Error('step.llm requires a non-empty id');
    if (!opts.model || opts.model.trim() === '') throw new Error('step.llm requires a non-empty model');
    return { kind: 'llm', ...opts };
  },

  tool<I, O>(opts: {
    id: string;
    tool: Tool<ZodType<I>, ZodType<O>>;
    args?: Partial<I>;
  }): StepTool<I, O> {
    if (!opts.id || opts.id.trim() === '') throw new Error('step.tool requires a non-empty id');
    if (!opts.tool) throw new Error('step.tool requires a tool');
    return { kind: 'tool', ...opts };
  },
};
