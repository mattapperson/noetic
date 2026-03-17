import type { ZodTypeAny, z } from 'zod';
import type { Tool } from '../types/common';
import type { ToolExecutionContext } from '../types/tool-context';

/**
 * Creates a typed Tool with Zod schema inference for input and output.
 *
 * The function infers types from the Zod schemas you provide, giving
 * full type safety on `execute` args and return value, while returning
 * the wide `Tool` type so the result is directly usable in `tools[]` arrays.
 *
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
}): Tool {
  if (!config.name || config.name.trim() === '') {
    throw new Error('tool() requires a non-empty name');
  }
  if (!config.execute) {
    throw new Error('tool() requires an execute function');
  }
  return {
    name: config.name,
    description: config.description,
    input: config.input,
    output: config.output,
    execute: config.execute,
    needsApproval: config.needsApproval,
  } satisfies Tool;
}
