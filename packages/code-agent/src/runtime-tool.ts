import type { Tool } from '@noetic/core';
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
      if (!implementation) {
        return opts.fallback(params);
      }
      return implementation.execute(params, ctx) as Promise<z.infer<O>>;
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
      if (!implementation) {
        return await opts.fallback(params);
      }
      const result = implementation.execute(params, ctx);
      if (isAsyncGenerator(result)) {
        const generator = result as AsyncGenerator<z.infer<E>, z.infer<O>>;
        while (true) {
          const next = await generator.next();
          if (next.done) {
            return next.value;
          }
          yield next.value;
        }
      }
      return (await result) as z.infer<O>;
    },
  });
}
