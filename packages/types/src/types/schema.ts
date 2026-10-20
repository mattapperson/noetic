import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import type { ZodTypeAny, z } from 'zod';
import { ZodError } from 'zod';
import { frameworkCast } from '../util/framework-cast';

export type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';

/**
 * Input type inferred from any Standard Schema. Zod schemas keep their exact
 * `z.input` inference; other vendors use `StandardSchemaV1.InferInput`.
 * @public
 */
export type InferSchemaInput<S extends StandardSchemaV1> = S extends ZodTypeAny
  ? z.input<S>
  : StandardSchemaV1.InferInput<S>;

/**
 * Output type inferred from any Standard Schema. Zod schemas keep their exact
 * `z.output` inference; other vendors use `StandardSchemaV1.InferOutput`.
 * @public
 */
export type InferSchemaOutput<S extends StandardSchemaV1> = S extends ZodTypeAny
  ? z.output<S>
  : StandardSchemaV1.InferOutput<S>;

/**
 * JSON Schema configuration for a tool input schema. Zod and Standard JSON
 * Schema implementations can derive their wire schema; validation-only
 * Standard Schemas require an explicit fallback.
 * @public
 */
export type InputSchemaConfig<S extends StandardSchemaV1> = StandardSchemaV1 extends S
  ? {
      inputJsonSchema?: Record<string, unknown>;
    }
  : S extends ZodTypeAny | StandardJSONSchemaV1
    ? {
        inputJsonSchema?: Record<string, unknown>;
      }
    : {
        inputJsonSchema: Record<string, unknown>;
      };

/** @public Type guard for Zod schemas (detected via the `_zod` internals marker). */
export function isZodSchema(schema: StandardSchemaV1): schema is ZodTypeAny {
  return '_zod' in schema;
}

/** @public Type guard for schemas implementing the Standard JSON Schema v1 companion spec. */
export function isStandardJsonSchema(
  schema: StandardSchemaV1,
): schema is StandardSchemaV1 & StandardJSONSchemaV1 {
  const standard = frameworkCast<{
    jsonSchema?: {
      input?: unknown;
    };
  }>(schema['~standard']);
  return typeof standard.jsonSchema?.input === 'function';
}

/** @public Successful result of `validateSchema` — carries the parsed/transformed value. */
export interface SchemaValidationSuccess<T> {
  success: true;
  value: T;
}

/**
 * Failed result of `validateSchema`. `issues` are the vendor's issues in
 * Standard Schema form; `zodError` adapts them into a `ZodError` (the
 * original error for Zod schemas, synthetic `custom` issues otherwise) so
 * consumers like `llm_parse_error` keep a single error surface.
 * @public
 */
export interface SchemaValidationFailure {
  success: false;
  issues: readonly StandardSchemaV1.Issue[];
  zodError: ZodError;
}

/** @public Result of `validateSchema`. */
export type SchemaValidationResult<T> = SchemaValidationSuccess<T> | SchemaValidationFailure;

function issuePathToPropertyKeys(path: StandardSchemaV1.Issue['path']): PropertyKey[] {
  if (!path) {
    return [];
  }
  return path.map((segment) =>
    typeof segment === 'object' && segment !== null && 'key' in segment ? segment.key : segment,
  );
}

/** @public Adapt Standard Schema issues into a synthetic `ZodError` of `custom` issues. */
export function standardIssuesToZodError(issues: readonly StandardSchemaV1.Issue[]): ZodError {
  return new ZodError(
    issues.map((issue) => ({
      code: 'custom' as const,
      message: issue.message,
      path: issuePathToPropertyKeys(issue.path),
    })),
  );
}

/**
 * Validates a value against any Standard Schema. Zod schemas take the
 * `safeParse` fast path; other vendors run `schema['~standard'].validate`,
 * awaiting sync or Promise results. The returned success value is the
 * parsed/transformed output.
 * @public
 */
export async function validateSchema<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<SchemaValidationResult<InferSchemaOutput<S>>> {
  if (isZodSchema(schema)) {
    const result = schema.safeParse(value);
    if (result.success) {
      return {
        success: true,
        value: frameworkCast<InferSchemaOutput<S>>(result.data),
      };
    }
    return {
      success: false,
      issues: result.error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path,
      })),
      zodError: result.error,
    };
  }
  const result = await schema['~standard'].validate(value);
  if (result.issues) {
    return {
      success: false,
      issues: result.issues,
      zodError: standardIssuesToZodError(result.issues),
    };
  }
  return {
    success: true,
    value: frameworkCast<InferSchemaOutput<S>>(result.value),
  };
}
