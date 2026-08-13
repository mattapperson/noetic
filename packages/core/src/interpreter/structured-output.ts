import type { StandardSchemaV1 } from '@noetic-tools/types';
import {
  frameworkCast,
  NoeticErrorImpl,
  standardIssuesToZodError,
  validateSchema,
} from '@noetic-tools/types';

/**
 * JSON-parse + validate assistant text against a Standard Schema, raising
 * `model_parse_error`. Shared by the LLM step and ACP agent step handlers.
 *
 * Zod schemas keep the original `safeParse` error; other vendors' Standard
 * Schema issues are adapted into a synthetic `ZodError` of `custom` issues so
 * `model_parse_error.zodError` stays a single error surface.
 */
export async function parseStructuredOutput<O>(params: {
  schema: StandardSchemaV1;
  rawText: string;
  stepId: string;
}): Promise<O> {
  const { schema, rawText, stepId } = params;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    throw new NoeticErrorImpl({
      kind: 'model_parse_error',
      stepId,
      raw: rawText,
      schema,
      zodError: standardIssuesToZodError([
        {
          message: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
        },
      ]),
    });
  }
  const result = await validateSchema(schema, parsed);
  if (!result.success) {
    throw new NoeticErrorImpl({
      kind: 'model_parse_error',
      stepId,
      raw: rawText,
      schema,
      zodError: result.zodError,
    });
  }
  return frameworkCast<O>(result.value);
}
