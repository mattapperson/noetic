import type { ZodType } from 'zod';
import type { ModelParams, RetryPolicy, Tool } from '../types/common';
import type { Context } from '../types/context';
import type { StepLLM, StepRun, StepTool } from '../types/step';

export const step = {
  /**
   * Creates a pure async computation step.
   *
   * @param opts.id - Unique step identifier used in traces and error messages.
   * @param opts.execute - Async function `(input, ctx) => output` that performs the work.
   * @param opts.retry - Optional retry policy controlling attempts, backoff, and delay.
   * @returns A `StepRun` that can be composed into larger pipelines.
   */
  run<I, O>(opts: {
    id: string;
    execute: (input: I, ctx: Context) => Promise<O>;
    retry?: RetryPolicy;
  }): StepRun<I, O> {
    if (!opts.id || opts.id.trim() === '') {
      throw new Error('step.run requires a non-empty id');
    }
    if (!opts.execute) {
      throw new Error('step.run requires an execute function');
    }
    return {
      kind: 'run',
      ...opts,
    };
  },

  /**
   * Creates an LLM model call step with optional tools and structured output.
   *
   * @param opts.id - Unique step identifier used in traces and error messages.
   * @param opts.model - Model identifier string (e.g. `'anthropic/claude-sonnet-4-20250514'`).
   * @param opts.system - Optional system prompt for the model.
   * @param opts.tools - Optional tools available to the model during this call.
   * @param opts.output - Optional Zod schema enabling structured output parsing.
   * @param opts.params - Optional model parameters (temperature, topP, maxTokens, stopSequences).
   * @returns A `StepLLM` that can be composed into larger pipelines.
   */
  llm<I, O>(opts: {
    id: string;
    model: string;
    system?: string;
    tools?: Tool[];
    output?: ZodType<O>;
    params?: ModelParams;
  }): StepLLM<I, O> {
    if (!opts.id || opts.id.trim() === '') {
      throw new Error('step.llm requires a non-empty id');
    }
    if (!opts.model || opts.model.trim() === '') {
      throw new Error('step.llm requires a non-empty model');
    }
    return {
      kind: 'llm',
      ...opts,
    };
  },

  /**
   * Creates a tool execution step that invokes a typed tool definition.
   *
   * @param opts.id - Unique step identifier used in traces and error messages.
   * @param opts.tool - The tool definition with typed input/output schemas.
   * @param opts.args - Optional partial args that override or supplement LLM-provided arguments.
   * @returns A `StepTool` that can be composed into larger pipelines.
   */
  tool<I, O>(opts: {
    id: string;
    tool: Tool<ZodType<I>, ZodType<O>>;
    args?: Partial<I>;
  }): StepTool<I, O> {
    if (!opts.id || opts.id.trim() === '') {
      throw new Error('step.tool requires a non-empty id');
    }
    if (!opts.tool) {
      throw new Error('step.tool requires a tool');
    }
    return {
      kind: 'tool',
      ...opts,
    };
  },
};
