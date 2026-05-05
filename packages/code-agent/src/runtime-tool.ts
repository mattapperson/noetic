import type { Tool, ToolExecutionContext } from '@noetic/core';
import { tool, toolWithGenerator } from '@noetic/core/portable';
import type { ZodTypeAny, z } from 'zod';

export interface RuntimeToolOptions<I extends ZodTypeAny, O extends ZodTypeAny> {
  name: string;
  description: string;
  input: I;
  output: O;
  load: () => Promise<Tool | null | undefined>;
  fallback: (params: z.infer<I>) => z.infer<O> | Promise<z.infer<O>>;
}

type RuntimeTool<I extends ZodTypeAny, O extends ZodTypeAny> = Omit<Tool<I, O>, 'execute'> & {
  execute(args: z.infer<I>, toolCtx: ToolExecutionContext): Promise<z.infer<O>>;
};

type RuntimeGeneratorTool<I extends ZodTypeAny, E extends ZodTypeAny, O extends ZodTypeAny> = Omit<
  Tool<I, O>,
  'execute'
> & {
  execute(
    args: z.infer<I>,
    toolCtx: ToolExecutionContext,
  ): AsyncGenerator<z.infer<E>, z.infer<O>> | Promise<z.infer<O>>;
};

function isRuntimeTool<I extends ZodTypeAny, O extends ZodTypeAny>(
  toolImpl: Tool | null | undefined,
  input: I,
  output: O,
): toolImpl is RuntimeTool<I, O> {
  return toolImpl?.input === input && toolImpl.output === output;
}

function isRuntimeGeneratorTool<I extends ZodTypeAny, E extends ZodTypeAny, O extends ZodTypeAny>(
  toolImpl: Tool | null | undefined,
  input: I,
  event: E,
  output: O,
): toolImpl is RuntimeGeneratorTool<I, E, O> {
  return toolImpl?.input === input && toolImpl.event === event && toolImpl.output === output;
}

export function createRuntimeTool<I extends ZodTypeAny, O extends ZodTypeAny>(
  opts: RuntimeToolOptions<I, O>,
): Tool<I, O> {
  return tool({
    name: opts.name,
    description: opts.description,
    input: opts.input,
    output: opts.output,
    async execute(params, ctx) {
      const implementation = await opts.load();
      if (!isRuntimeTool(implementation, opts.input, opts.output)) {
        return opts.fallback(params);
      }
      return implementation.execute(params, ctx);
    },
  });
}

export interface RuntimeGeneratorToolOptions<
  I extends ZodTypeAny,
  E extends ZodTypeAny,
  O extends ZodTypeAny,
> extends RuntimeToolOptions<I, O> {
  event: E;
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

export function createRuntimeGeneratorTool<
  I extends ZodTypeAny,
  E extends ZodTypeAny,
  O extends ZodTypeAny,
>(opts: RuntimeGeneratorToolOptions<I, E, O>): Tool<I, O> {
  return toolWithGenerator({
    name: opts.name,
    description: opts.description,
    input: opts.input,
    event: opts.event,
    output: opts.output,
    async *execute(params, ctx) {
      const implementation = await opts.load();
      if (!isRuntimeGeneratorTool(implementation, opts.input, opts.event, opts.output)) {
        return await opts.fallback(params);
      }
      const result = implementation.execute(params, ctx);
      if (isAsyncGenerator(result)) {
        while (true) {
          const next = await result.next();
          if (next.done) {
            return next.value;
          }
          yield next.value;
        }
      }
      return await result;
    },
  });
}
