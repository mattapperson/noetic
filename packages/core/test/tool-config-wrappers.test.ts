/**
 * Generic wrapper functions over tool() / toolWithGenerator() — the pattern this
 * file guards is COMPILE-TIME: `InputSchemaConfig<I>` stays deferred over an
 * unresolved type parameter and TypeScript cannot check assignment to a deferred
 * conditional, so before ZodToolConfig + the Zod-bound overloads a wrapper
 * generic in `I` could not construct a config at all (every call site needed
 * `@ts-expect-error`). This file failing to typecheck IS the regression.
 */
import { describe, expect, it } from 'bun:test';
import type {
  InferSchemaOutput,
  StandardSchemaV1,
  Tool,
  ToolExecutionContext,
} from '@noetic-tools/types';
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';
import type {
  ToolConfig,
  ZodGeneratorToolConfig,
  ZodToolConfig,
} from '../src/builders/tool-builder';
import { tool, toolWithGenerator } from '../src/builders/tool-builder';
import { makeMockToolContext } from './_helpers';

// The exact shape consumers write: options generic in Zod schemas, a constructed
// config literal, no inputJsonSchema (Zod derives its own wire schema).
function wrapTool<I extends ZodTypeAny, O extends ZodTypeAny>(opts: {
  name: string;
  input: I;
  output: O;
  run: (args: InferSchemaOutput<I>) => Promise<InferSchemaOutput<O>>;
}): Tool<I, O> {
  const config: ZodToolConfig<I, O> = {
    name: opts.name,
    description: `wrapped ${opts.name}`,
    input: opts.input,
    output: opts.output,
    async execute(args) {
      return opts.run(args);
    },
  };
  return tool(config);
}

function wrapGeneratorTool<I extends ZodTypeAny, E extends ZodTypeAny, O extends ZodTypeAny>(opts: {
  name: string;
  input: I;
  event: E;
  output: O;
  run: (args: InferSchemaOutput<I>) => AsyncGenerator<InferSchemaOutput<E>, InferSchemaOutput<O>>;
}): Tool<I, O> {
  const config: ZodGeneratorToolConfig<I, E, O> = {
    name: opts.name,
    description: `wrapped ${opts.name}`,
    input: opts.input,
    event: opts.event,
    output: opts.output,
    execute(args, _toolCtx: ToolExecutionContext) {
      return opts.run(args);
    },
  };
  return toolWithGenerator(config);
}

// A validation-only Standard Schema (no Zod internals, no JSON-schema companion):
// the general ToolConfig must still REQUIRE inputJsonSchema for it statically.
const validationOnly: StandardSchemaV1<{
  n: number;
}> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => {
      const record: Record<string, unknown> =
        value !== null && typeof value === 'object'
          ? {
              ...value,
            }
          : {};
      return {
        value: {
          n: typeof record.n === 'number' ? record.n : 0,
        },
      };
    },
  },
};

describe('Zod-bound tool config wrappers', () => {
  it('a generic Zod wrapper compiles and executes without inputJsonSchema', async () => {
    const doubled = wrapTool({
      name: 'double',
      input: z.object({
        n: z.number(),
      }),
      output: z.object({
        result: z.number(),
      }),
      run: async (args) => ({
        result: args.n * 2,
      }),
    });
    const out = await doubled.execute?.(
      {
        n: 21,
      },
      makeMockToolContext(),
    );
    expect(out).toEqual({
      result: 42,
    });
  });

  it('a generic Zod generator wrapper compiles and streams', async () => {
    const counter = wrapGeneratorTool({
      name: 'count',
      input: z.object({
        upTo: z.number(),
      }),
      event: z.object({
        tick: z.number(),
      }),
      output: z.object({
        total: z.number(),
      }),
      async *run(args) {
        for (let i = 1; i <= args.upTo; i++) {
          yield {
            tick: i,
          };
        }
        return {
          total: args.upTo,
        };
      },
    });
    const gen = counter.execute?.(
      {
        upTo: 2,
      },
      makeMockToolContext(),
    );
    expect(gen).toBeDefined();
  });

  it('the general overload still statically requires inputJsonSchema for validation-only schemas', () => {
    // With the explicit wire schema the config is accepted…
    const explicit: ToolConfig<typeof validationOnly, typeof validationOnly> = {
      name: 'raw',
      description: 'validation-only schema',
      input: validationOnly,
      output: validationOnly,
      inputJsonSchema: {
        type: 'object',
      },
      execute: async (args) => args,
    };
    expect(explicit.inputJsonSchema).toBeDefined();

    // …and without it the assignment must NOT typecheck.
    // @ts-expect-error validation-only Standard Schemas cannot derive a wire schema
    const missing: ToolConfig<typeof validationOnly, typeof validationOnly> = {
      name: 'raw2',
      description: 'validation-only schema, no wire schema',
      input: validationOnly,
      output: validationOnly,
      execute: async (args) => args,
    };
    expect(missing.name).toBe('raw2');
  });
});
