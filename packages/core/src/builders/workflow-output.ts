/**
 * Structured output written in a JSON workflow document (spec 26 § Structured
 * output): a node's `output: { "schema" }` as a validator the step parses its
 * answer with.
 */

import type { StandardSchemaV1, WorkflowNode } from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError, walkWorkflow } from '@noetic-tools/types';
import { z } from 'zod';

//#region Public API

/**
 * A validator for a node's `output.schema`. It is not a Zod schema to the
 * harness, so a `callModel` step sends the model the document's own JSON
 * Schema (its `outputJsonSchema`) instead of one derived back from Zod.
 *
 * @throws `NoeticConfigError` `INVALID_OUTPUT_SCHEMA` when the JSON Schema does not load.
 */
export function outputSchemaOf(schema: Record<string, unknown>, nodeId: string): StandardSchemaV1 {
  const loaded = load(schema, nodeId);
  return {
    '~standard': {
      version: 1,
      vendor: 'noetic',
      validate: (value) => loaded['~standard'].validate(value),
    },
  };
}

/** A message for every `output.schema` in the tree under `root` that does not load. Empty when all load. */
export function outputSchemaErrors(root: WorkflowNode): string[] {
  const errors: string[] = [];
  for (const node of walkWorkflow(root)) {
    const schema = schemaOf(node);
    if (schema === undefined) {
      continue;
    }
    try {
      load(schema, node.id);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}

//#endregion

//#region Helpers

function schemaOf(node: WorkflowNode): Record<string, unknown> | undefined {
  if (node.kind !== 'callModel' && node.kind !== 'acp-agent') {
    return undefined;
  }
  return node.output && 'schema' in node.output ? node.output.schema : undefined;
}

function load(schema: Record<string, unknown>, nodeId: string): z.ZodType {
  try {
    return z.fromJSONSchema(frameworkCast<z.core.JSONSchema.JSONSchema>(schema));
  } catch (error) {
    throw new NoeticConfigError({
      code: 'INVALID_OUTPUT_SCHEMA',
      message: `The output JSON Schema of workflow node '${nodeId}' does not load: ${error instanceof Error ? error.message : String(error)}`,
      hint: 'Give a JSON Schema that z.fromJSONSchema loads, e.g. { "type": "object", "properties": { … } }.',
    });
  }
}

//#endregion
