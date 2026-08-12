import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  ContextData,
  StandardJSONSchemaV1,
  StandardSchemaV1,
  StepLLM,
  StepTool,
  Tool,
} from '@noetic-tools/types';
import {
  frameworkCast,
  isNoeticConfigError,
  isNoeticError,
  NoeticConfigError,
} from '@noetic-tools/types';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';
import { ZodError, z } from 'zod';
import { convertTools, executeToolCall, resolveWireJsonSchema } from '../src/adapters/openrouter';
import { step } from '../src/builders/step-builders';
import { tool } from '../src/builders/tool-builder';
import { AgentHarness } from '../src/harness/agent-harness';
import { executeLLM, executeTool } from '../src/interpreter/execute-action';
import {
  makeLLMResponse,
  makeMockContext,
  makeMockContextWithClient,
  makeMockHarness,
} from './_helpers';

describe('tool() with Standard Schema (valibot)', () => {
  it('preserves exact input/output inference', async () => {
    const t = tool({
      name: 'greet',
      description: 'Greet by name',
      input: v.object({
        name: v.string(),
      }),
      inputJsonSchema: {
        type: 'object',
      },
      output: v.object({
        greeting: v.string(),
      }),
      execute: async (args) => {
        const name: string = args.name;
        return {
          greeting: `hi ${name}`,
        };
      },
    });
    const result = await t.execute(
      {
        name: 'ada',
      },
      undefined,
    );
    assert(!(Symbol.asyncIterator in result));
    const greeting: string = result.greeting;
    expect(greeting).toBe('hi ada');
  });

  it('supports transformed outputs in inference', () => {
    tool({
      name: 'len',
      description: 'String length',
      input: v.pipe(
        v.object({
          text: v.string(),
        }),
        v.transform((o) => o.text),
      ),
      inputJsonSchema: {
        type: 'object',
      },
      output: v.number(),
      execute: async (args) => {
        const text: string = args;
        return text.length;
      },
    });
  });
});

describe('executeToolCall input validation', () => {
  const ctx = makeMockContext();
  const harness = makeMockHarness();

  it('returns a tool error result on invalid valibot input instead of throwing', async () => {
    const t = tool({
      name: 'greet',
      description: 'Greet by name',
      input: v.object({
        name: v.string(),
      }),
      inputJsonSchema: {
        type: 'object',
      },
      output: v.object({
        greeting: v.string(),
      }),
      execute: async (args) => ({
        greeting: `hi ${args.name}`,
      }),
    });
    const result = await executeToolCall({
      toolName: 'greet',
      args: {
        name: 42,
      },
      tools: [
        t,
      ],
      context: ctx,
      harness,
    });
    expect(result.error).toBe(true);
    expect(result.output).toContain("invalid arguments for tool 'greet'");
  });

  it('passes the parsed/transformed value to execute', async () => {
    const t = tool({
      name: 'shout',
      description: 'Uppercase the text',
      input: v.pipe(
        v.object({
          text: v.string(),
        }),
        v.transform((o) => o.text.toUpperCase()),
      ),
      inputJsonSchema: {
        type: 'object',
      },
      output: v.string(),
      execute: async (args) => {
        const text: string = args;
        return text;
      },
    });
    const result = await executeToolCall({
      toolName: 'shout',
      args: {
        text: 'hello',
      },
      tools: [
        t,
      ],
      context: ctx,
      harness,
    });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe('HELLO');
  });

  it('keeps the Zod fast path unchanged', async () => {
    const t = tool({
      name: 'add',
      description: 'Add',
      input: z.object({
        a: z.number(),
      }),
      output: z.number(),
      execute: async (args) => args.a + 1,
    });
    const bad = await executeToolCall({
      toolName: 'add',
      args: {
        a: 'nope',
      },
      tools: [
        t,
      ],
      context: ctx,
      harness,
    });
    expect(bad.error).toBe(true);
    const good = await executeToolCall({
      toolName: 'add',
      args: {
        a: 1,
      },
      tools: [
        t,
      ],
      context: ctx,
      harness,
    });
    expect(good.result).toBe(2);
  });
});

describe('executeTool (step.tool) with valibot', () => {
  const ctx = makeMockContext();
  const harness = makeMockHarness();

  it('validates input and returns output', async () => {
    const t = tool({
      name: 'greet',
      description: 'Greet by name',
      input: v.object({
        name: v.string(),
      }),
      inputJsonSchema: {
        type: 'object',
      },
      output: v.object({
        greeting: v.string(),
      }),
      execute: async (args) => ({
        greeting: `hi ${args.name}`,
      }),
    });
    const s: StepTool<
      ContextData,
      {
        name: string;
      },
      {
        greeting: string;
      }
    > = {
      kind: 'tool',
      id: 'greet-step',
      tool: t,
    };
    const result = await executeTool(
      s,
      {
        name: 'ada',
      },
      ctx,
      harness,
    );
    expect(result).toEqual({
      greeting: 'hi ada',
    });
  });

  it('throws step_failed on invalid input', async () => {
    const t = tool({
      name: 'greet',
      description: 'Greet by name',
      input: v.object({
        name: v.string(),
      }),
      inputJsonSchema: {
        type: 'object',
      },
      output: v.object({
        greeting: v.string(),
      }),
      execute: async (args) => ({
        greeting: `hi ${args.name}`,
      }),
    });
    const s: StepTool<
      ContextData,
      {
        name: string;
      },
      {
        greeting: string;
      }
    > = {
      kind: 'tool',
      id: 'greet-step',
      tool: t,
    };
    try {
      await executeTool(
        s,
        frameworkCast<{
          name: string;
        }>({
          name: 42,
        }),
        ctx,
        harness,
      );
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('step_failed');
    }
  });
});

describe('step.llm structured output with Standard Schema', () => {
  it('validates valibot output and preserves transformed data', async () => {
    const schema = v.pipe(
      v.object({
        answer: v.string(),
      }),
      v.transform((o) => o.answer),
    );
    const s: StepLLM<ContextData, string, string> = {
      kind: 'llm',
      id: 'valibot-out',
      model: 'gpt-4',
      output: schema,
      outputJsonSchema: {
        type: 'object',
        properties: {
          answer: {
            type: 'string',
          },
        },
        required: [
          'answer',
        ],
      },
    };
    const ctx = makeMockContextWithClient([
      makeLLMResponse('{"answer":"42"}'),
    ]);
    const result = await executeLLM(s, 'hi', ctx);
    const answer: string = result;
    expect(answer).toBe('42');
  });

  it('supports async custom Standard Schema validation', async () => {
    const schema: StandardSchemaV1<
      unknown,
      {
        ok: true;
      }
    > = {
      '~standard': {
        version: 1,
        vendor: 'noetic-test',
        validate: async (value) => {
          await new Promise((r) => setTimeout(r, 1));
          if (typeof value === 'object' && value !== null && 'ok' in value) {
            return {
              value: {
                ok: true,
              },
            };
          }
          return {
            issues: [
              {
                message: 'missing ok',
              },
            ],
          };
        },
      },
    };
    const s: StepLLM<
      ContextData,
      string,
      {
        ok: true;
      }
    > = {
      kind: 'llm',
      id: 'custom-out',
      model: 'gpt-4',
      output: schema,
      outputJsonSchema: {
        type: 'object',
      },
    };
    const ctx = makeMockContextWithClient([
      makeLLMResponse('{"ok":true}'),
    ]);
    const result = await executeLLM(s, 'hi', ctx);
    expect(result).toEqual({
      ok: true,
    });
  });

  it('maps valibot failures into llm_parse_error with a synthetic ZodError', async () => {
    const schema = v.object({
      answer: v.string(),
    });
    const s: StepLLM<ContextData, string, v.InferOutput<typeof schema>> = {
      kind: 'llm',
      id: 'valibot-fail',
      model: 'gpt-4',
      output: schema,
      outputJsonSchema: {
        type: 'object',
      },
    };
    const ctx = makeMockContextWithClient([
      makeLLMResponse('{"wrong":"field"}'),
    ]);
    try {
      await executeLLM(s, 'hi', ctx);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('llm_parse_error');
      if (e.noeticError.kind !== 'llm_parse_error') {
        return;
      }
      expect(e.noeticError.schema).toBe(schema);
      expect(e.noeticError.raw).toBe('{"wrong":"field"}');
      expect(e.noeticError.zodError).toBeInstanceOf(ZodError);
      const issue = e.noeticError.zodError.issues[0];
      expect(issue.code).toBe('custom');
      expect(issue.path).toEqual([
        'answer',
      ]);
      expect(issue.message).toContain('answer');
    }
  });
});

describe('JSON Schema wire boundaries', () => {
  it('uses the StandardJSONSchemaV1 trait without inputJsonSchema', () => {
    const input = toStandardJsonSchema(
      v.object({
        name: v.string(),
      }),
    );
    const t = tool({
      name: 'greet',
      description: 'Greet by name',
      input,
      output: v.string(),
      execute: async ({ name }) => `hi ${name}`,
    });
    const [sdkTool] = convertTools({
      tools: [
        t,
      ],
    });
    const fn = frameworkCast<{
      function: {
        inputSchema: z.ZodTypeAny;
      };
    }>(sdkTool).function;
    expect(
      z.toJSONSchema(fn.inputSchema, {
        target: 'draft-07',
      }),
    ).toMatchObject({
      type: 'object',
      properties: {
        name: {
          type: 'string',
        },
      },
      required: [
        'name',
      ],
    });
  });

  it('uses inputJsonSchema for a schema whose trait converter would throw', () => {
    const input: StandardSchemaV1 & StandardJSONSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'throwing-test',
        validate: (value: unknown) => ({
          value,
        }),
        jsonSchema: {
          input: () => {
            throw new Error('unsupported target');
          },
          output: () => {
            throw new Error('unsupported target');
          },
        },
      },
    };
    const fallback = {
      type: 'string',
    };
    expect(
      resolveWireJsonSchema({
        schema: input,
        explicitJsonSchema: fallback,
        what: 'test schema',
      }),
    ).toEqual(fallback);
  });

  it('maps a throwing trait converter without a fallback to MISSING_JSON_SCHEMA', () => {
    const schema: StandardSchemaV1 & StandardJSONSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'throwing-test',
        validate: (value: unknown) => ({
          value,
        }),
        jsonSchema: {
          input: () => {
            throw new Error('unsupported target');
          },
          output: () => ({}),
        },
      },
    };
    expect(() =>
      resolveWireJsonSchema({
        schema,
        what: 'test schema',
      }),
    ).toThrow('cannot be converted to JSON Schema');
  });

  it('lets explicit inputJsonSchema override the trait', () => {
    const trait = toStandardJsonSchema(v.string());
    const explicit = {
      type: 'number',
    };
    expect(
      resolveWireJsonSchema({
        schema: trait,
        explicitJsonSchema: explicit,
        what: 'test schema',
      }),
    ).toEqual(explicit);
  });

  it('strips tilde-prefixed keys from trait output', () => {
    const schema: StandardSchemaV1 & StandardJSONSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'sanitize-test',
        validate: (value: unknown) => ({
          value,
        }),
        jsonSchema: {
          input: () => ({
            type: 'object',
            '~internal': true,
            properties: {
              value: {
                type: 'string',
                '~nested': true,
              },
            },
          }),
          output: () => ({}),
        },
      },
    };
    expect(
      resolveWireJsonSchema({
        schema,
        what: 'test schema',
      }),
    ).toEqual({
      type: 'object',
      properties: {
        value: {
          type: 'string',
        },
      },
    });
  });

  it('emits the explicit raw JSON Schema for a non-Zod tool input', () => {
    const raw = {
      type: 'object',
      properties: {
        name: {
          type: 'string',
        },
      },
      required: [
        'name',
      ],
    };
    const t = tool({
      name: 'greet',
      description: 'Greet by name',
      input: v.object({
        name: v.string(),
      }),
      inputJsonSchema: raw,
      output: v.string(),
      execute: async () => 'ok',
    });
    const [sdkTool] = convertTools({
      tools: [
        t,
      ],
    });
    const fn = frameworkCast<{
      function: {
        inputSchema: z.ZodTypeAny;
      };
    }>(sdkTool).function;
    const generated = z.toJSONSchema(fn.inputSchema, {
      target: 'draft-07',
    });
    expect(generated).toMatchObject(raw);
  });

  it('passes Zod tool inputs through unchanged', () => {
    const input = z.object({
      q: z.string(),
    });
    const t = tool({
      name: 'search',
      description: 'Search',
      input,
      output: z.string(),
      execute: async () => 'ok',
    });
    const [sdkTool] = convertTools({
      tools: [
        t,
      ],
    });
    const fn = frameworkCast<{
      function: {
        inputSchema: z.ZodTypeAny;
      };
    }>(sdkTool).function;
    expect(fn.inputSchema).toBe(input);
    expect(z.toJSONSchema(fn.inputSchema)).toEqual(z.toJSONSchema(input));
  });

  it('throws MISSING_JSON_SCHEMA for a non-Zod tool input without inputJsonSchema', () => {
    const t = frameworkCast<Tool>({
      name: 'greet',
      description: 'Greet by name',
      input: v.object({
        name: v.string(),
      }),
      output: v.string(),
      execute: async () => 'ok',
    });
    try {
      convertTools({
        tools: [
          t,
        ],
      });
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('MISSING_JSON_SCHEMA');
    }
  });

  it('uses the StandardJSONSchemaV1 trait for structured output', () => {
    const schema = toStandardJsonSchema(
      v.object({
        answer: v.string(),
      }),
    );
    expect(
      resolveWireJsonSchema({
        schema,
        what: 'structured output schema',
      }),
    ).toMatchObject({
      type: 'object',
      properties: {
        answer: {
          type: 'string',
        },
      },
      required: [
        'answer',
      ],
    });
  });

  it('sends outputJsonSchema to the model for a non-Zod output schema', async () => {
    const raw = {
      type: 'object',
      properties: {
        answer: {
          type: 'string',
        },
      },
      required: [
        'answer',
      ],
    };
    let request: unknown;
    const client = {
      callModel(value: unknown) {
        request = value;
        return {
          async *getFullResponsesStream() {},
          getResponse: async () =>
            frameworkCast({
              id: 'response-1',
              status: 'completed',
              output: [
                {
                  id: 'message-1',
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [
                    {
                      type: 'output_text',
                      text: '{"answer":"42"}',
                    },
                  ],
                },
              ],
              usage: {
                inputTokens: 1,
                outputTokens: 1,
              },
            }),
        };
      },
    };
    const harness = new AgentHarness({
      name: 'standard-schema-test',
      params: {},
    });
    frameworkCast<{
      client: typeof client;
    }>(harness).client = client;
    await harness.callModel({
      model: 'test/model',
      items: [],
      outputSchema: v.object({
        answer: v.string(),
      }),
      outputJsonSchema: raw,
    });

    expect(request).toMatchObject({
      text: {
        format: {
          type: 'json_schema',
          name: 'output',
          schema: raw,
        },
      },
    });
  });

  it('throws MISSING_JSON_SCHEMA for a non-Zod output schema without outputJsonSchema', () => {
    try {
      resolveWireJsonSchema({
        schema: v.object({
          answer: v.string(),
        }),
        what: 'structured output schema',
      });
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(e instanceof NoeticConfigError);
      expect(e.code).toBe('MISSING_JSON_SCHEMA');
    }
  });

  it('derives JSON Schema automatically for Zod output schemas', () => {
    const schema = z.object({
      answer: z.string(),
    });
    expect(
      resolveWireJsonSchema({
        schema,
        what: 'structured output schema',
      }),
    ).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        answer: {
          type: 'string',
        },
      },
      required: [
        'answer',
      ],
      additionalProperties: false,
    });
  });
});

describe('step builders accept Standard Schema outputs', () => {
  it('step.llm infers output type from a valibot schema', () => {
    const s = step.llm({
      id: 'infer-llm',
      model: 'gpt-4',
      output: v.object({
        answer: v.string(),
      }),
      outputJsonSchema: {
        type: 'object',
      },
    });
    expect(s.output).toBeDefined();
  });

  it('step.tool accepts a valibot-backed tool', () => {
    const t = tool({
      name: 'greet',
      description: 'Greet by name',
      input: v.object({
        name: v.string(),
      }),
      inputJsonSchema: {
        type: 'object',
      },
      output: v.object({
        greeting: v.string(),
      }),
      execute: async (args) => ({
        greeting: `hi ${args.name}`,
      }),
    });
    const s = step.tool({
      id: 'infer-tool',
      tool: t,
    });
    expect(s.tool.name).toBe('greet');
  });
});
