import type { ZodType } from 'zod';
import { NoeticConfigError } from '../errors/noetic-config-error';
import type { ModelParams, RetryPolicy, Tool } from '../types/common';
import type { Context } from '../types/context';
import type { StepLLM, StepRun, StepTool } from '../types/step';

export const step = {
  /**
   * Creates a pure async computation step.
   *
   * @public
   * @param opts.id - Unique step identifier used in traces and error messages.
   * @param opts.execute - Async function `(input, ctx) => output` that performs the work.
   * @param opts.retry - Optional retry policy controlling attempts, backoff, and delay.
   * @returns A `StepRun` that can be composed into larger pipelines.
   * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
   * @throws `NoeticConfigError` with code `MISSING_EXECUTE_FUNCTION` if `execute` is not provided.
   */
  run<I, O>(opts: {
    id: string;
    execute: (input: I, ctx: Context) => Promise<O>;
    retry?: RetryPolicy;
  }): StepRun<I, O> {
    if (!opts.id || opts.id.trim() === '') {
      throw new NoeticConfigError({
        code: 'EMPTY_STEP_ID',
        message: 'step.run() requires a non-empty id.',
        hint: 'Pass a unique string as the id field, e.g. step.run({ id: "my-step", ... }).',
      });
    }
    if (!opts.execute) {
      throw new NoeticConfigError({
        code: 'MISSING_EXECUTE_FUNCTION',
        message: 'step.run() requires an execute function.',
        hint: 'Provide an async execute function, e.g. execute: async (input, ctx) => result.',
      });
    }
    return {
      kind: 'run',
      ...opts,
    };
  },

  /**
   * Creates an LLM model call step with optional tools and structured output.
   *
   * @public
   * @param opts.id - Unique step identifier used in traces and error messages.
   * @param opts.model - Model identifier string (e.g. `'anthropic/claude-sonnet-4-20250514'`).
   * @param opts.system - Optional system prompt for the model.
   * @param opts.tools - Optional tools available to the model during this call.
   * @param opts.output - Optional Zod schema enabling structured output parsing.
   * @param opts.params - Optional model parameters (temperature, topP, maxTokens, stopSequences).
   * @returns A `StepLLM` that can be composed into larger pipelines.
   * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
   * @throws `NoeticConfigError` with code `MISSING_MODEL` if `model` is empty.
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
      throw new NoeticConfigError({
        code: 'EMPTY_STEP_ID',
        message: 'step.llm() requires a non-empty id.',
        hint: 'Pass a unique string as the id field, e.g. step.llm({ id: "my-llm", ... }).',
      });
    }
    if (!opts.model || opts.model.trim() === '') {
      throw new NoeticConfigError({
        code: 'MISSING_MODEL',
        message: 'step.llm() requires a non-empty model.',
        hint: "Pass a model identifier, e.g. model: 'anthropic/claude-sonnet-4-20250514'.",
      });
    }
    return {
      kind: 'llm',
      ...opts,
    };
  },

  /**
   * Creates a tool execution step that invokes a typed tool definition.
   *
   * @public
   * @param opts.id - Unique step identifier used in traces and error messages.
   * @param opts.tool - The tool definition with typed input/output schemas.
   * @param opts.args - Optional partial args that override or supplement LLM-provided arguments.
   * @returns A `StepTool` that can be composed into larger pipelines.
   * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
   * @throws `NoeticConfigError` with code `MISSING_TOOL` if `tool` is not provided.
   */
  tool<I, O>(opts: {
    id: string;
    tool: Tool<ZodType<I>, ZodType<O>>;
    args?: Partial<I>;
  }): StepTool<I, O> {
    if (!opts.id || opts.id.trim() === '') {
      throw new NoeticConfigError({
        code: 'EMPTY_STEP_ID',
        message: 'step.tool() requires a non-empty id.',
        hint: 'Pass a unique string as the id field, e.g. step.tool({ id: "my-tool", ... }).',
      });
    }
    if (!opts.tool) {
      throw new NoeticConfigError({
        code: 'MISSING_TOOL',
        message: 'step.tool() requires a tool.',
        hint: 'Provide a tool definition created with the tool() builder.',
      });
    }
    return {
      kind: 'tool',
      ...opts,
    };
  },
};
