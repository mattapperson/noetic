import type { ZodTypeAny, z } from 'zod';

import { NoeticConfigError } from '../errors/noetic-config-error';
import type { Tool } from '../types/common';
import type { ToolExecutionContext } from '../types/tool-context';

//#region Types

interface ToolConfig<I extends ZodTypeAny, O extends ZodTypeAny> {
  name: string;
  description: string;
  input: I;
  output: O;
  execute: (args: z.infer<I>, toolCtx: ToolExecutionContext) => Promise<z.infer<O>>;
  needsApproval?: boolean;
}

interface GeneratorToolConfig<I extends ZodTypeAny, E extends ZodTypeAny, O extends ZodTypeAny> {
  name: string;
  description: string;
  input: I;
  event: E;
  output: O;
  execute: (args: z.infer<I>, toolCtx: ToolExecutionContext) => AsyncGenerator<z.infer<E>, z.infer<O>>;
  needsApproval?: boolean;
}

//#endregion

//#region Helpers

function validateToolConfig(name: string, execute: unknown): void {
  if (!name || name.trim() === '') {
    throw new NoeticConfigError({
      code: 'EMPTY_TOOL_NAME',
      message: 'tool() requires a non-empty name.',
      hint: "Pass a unique name for the tool, e.g. tool({ name: 'greet', ... }).",
    });
  }

  if (!execute) {
    throw new NoeticConfigError({
      code: 'MISSING_EXECUTE_FUNCTION',
      message: 'tool() requires an execute function.',
      hint: 'Provide an async execute function, e.g. execute: async (args, toolCtx) => result.',
    });
  }
}

//#endregion

//#region Public API

/**
 * Creates a typed Tool with Zod schema inference for input and output.
 *
 * @public
 */
export function tool<I extends ZodTypeAny, O extends ZodTypeAny>(config: ToolConfig<I, O>): Tool<I, O> {
  validateToolConfig(config.name, config.execute);

  return {
    name: config.name,
    description: config.description,
    input: config.input,
    output: config.output,
    execute: config.execute,
    needsApproval: config.needsApproval,
  } satisfies Tool<I, O>;
}

/**
 * Creates a typed Tool that can stream progress events before returning a final output.
 *
 * @public
 */
export function toolWithGenerator<I extends ZodTypeAny, E extends ZodTypeAny, O extends ZodTypeAny>(
  config: GeneratorToolConfig<I, E, O>,
): Tool<I, O> {
  validateToolConfig(config.name, config.execute);

  return {
    name: config.name,
    description: config.description,
    input: config.input,
    event: config.event,
    output: config.output,
    execute: config.execute,
    needsApproval: config.needsApproval,
  } satisfies Tool<I, O>;
}

//#endregion
