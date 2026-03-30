import type { ZodType } from 'zod';
import type { ExecutionContext, LayerDataDecl, LayerFunctionDecl } from '../types/memory';

/**
 * Creates a read-only data declaration for a memory layer's `provides` map.
 *
 * @public
 * @param opts.read - Function that projects a value from the layer's current state.
 * @returns A `LayerDataDecl` to include in a layer's `provides`.
 */
export function layerData<T, TState>(opts: {
  read: (state: TState) => T;
}): LayerDataDecl<T, TState> {
  return {
    kind: 'data',
    read: opts.read,
  };
}

/**
 * Creates a callable function declaration for a memory layer's `provides` map.
 * Functions are accessible via `ctx.memory['layerId'].fn()` and automatically exposed as LLM tools.
 *
 * @public
 * @param opts.description - Human-readable description (used as tool description for LLM).
 * @param opts.input - Zod schema validating input arguments.
 * @param opts.output - Zod schema validating the return value.
 * @param opts.execute - Async function receiving args, current state, and execution context.
 * @returns A `LayerFunctionDecl` to include in a layer's `provides`.
 */
export function layerFn<TInput, TOutput, TState>(opts: {
  description: string;
  input: ZodType<TInput>;
  output: ZodType<TOutput>;
  execute: (
    args: TInput,
    state: TState,
    ctx: ExecutionContext,
  ) => Promise<{
    result: TOutput;
    state?: TState;
  }>;
}): LayerFunctionDecl<TInput, TOutput, TState> {
  return {
    kind: 'function',
    description: opts.description,
    input: opts.input,
    output: opts.output,
    execute: opts.execute,
  };
}
