import type { ZodTypeAny, z } from 'zod';
import { NoeticConfigError } from '../errors/noetic-config-error';
import type { Tool } from '../types/common';
import type { ToolExecutionContext } from '../types/tool-context';

/**
 * Creates a typed Tool with Zod schema inference for input and output.
 *
 * The function infers types from the Zod schemas you provide, giving
 * full type safety on `execute` args and return value, while returning
 * the wide `Tool` type so the result is directly usable in `tools[]` arrays.
 *
 * @param config.name - Unique tool name used by the LLM for selection.
 * @param config.description - Human-readable description shown to the LLM.
 * @param config.input - Zod schema validating tool input arguments.
 * @param config.output - Zod schema validating tool return value.
 * @param config.execute - Async function `(args, toolCtx) => result` that performs the tool's work.
 * @param config.needsApproval - When true, execution pauses for human approval before running.
 * @returns A `Tool` instance usable in `step.llm` tool arrays.
 * @throws `NoeticConfigError` with code `EMPTY_TOOL_NAME` if `name` is empty.
 * @throws `NoeticConfigError` with code `MISSING_EXECUTE_FUNCTION` if `execute` is not provided.
 *
 * @public
 * @example
 * ```ts
 * const myTool = tool({
 *   name: 'greet',
 *   description: 'Greet a user by name',
 *   input: z.object({ name: z.string() }),
 *   output: z.string(),
 *   execute: async (args) => `Hello, ${args.name}!`,
 * });
 * ```
 */
export function tool<I extends ZodTypeAny, O extends ZodTypeAny>(config: {
  name: string;
  description: string;
  input: I;
  output: O;
  execute: (args: z.infer<I>, toolCtx: ToolExecutionContext) => Promise<z.infer<O>>;
  needsApproval?: boolean;
}): Tool<I, O> {
  if (!config.name || config.name.trim() === '') {
    throw new NoeticConfigError({
      code: 'EMPTY_TOOL_NAME',
      message: 'tool() requires a non-empty name.',
      hint: "Pass a unique name for the tool, e.g. tool({ name: 'greet', ... }).",
    });
  }
  if (!config.execute) {
    throw new NoeticConfigError({
      code: 'MISSING_EXECUTE_FUNCTION',
      message: 'tool() requires an execute function.',
      hint: 'Provide an async execute function, e.g. execute: async (args, toolCtx) => result.',
    });
  }
  return {
    name: config.name,
    description: config.description,
    input: config.input,
    output: config.output,
    execute: config.execute,
    needsApproval: config.needsApproval,
  } satisfies Tool<I, O>;
}
