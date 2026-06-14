/**
 * Generates the published JSON Schema for Noetic dynamic (JSON) workflows
 * from the canonical Zod schema, so external tooling, editors, and LLM
 * planners can validate `WorkflowDocument`s without depending on the runtime.
 *
 * The Zod schema in `src/schemas/workflow.ts` is the single source of truth;
 * this module is its serialiser. Re-run after changing that schema:
 *
 *   bun run gen:schema
 *
 * Output: `schema/noetic-workflow.schema.json` (committed + published in the
 * package `files` allowlist). A drift-gate test re-imports
 * `buildWorkflowJsonSchema` and asserts the committed file is up to date.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { WorkflowDocumentSchema } from '../src/schemas/workflow';

/** Canonical, stable identifier for the published workflow schema. */
export const SCHEMA_ID = 'https://noetic.tools/schema/noetic-workflow.schema.json';

/** Absolute path of the committed schema artifact. */
export const SCHEMA_OUTPUT_PATH = join(
  import.meta.dir,
  '..',
  'schema',
  'noetic-workflow.schema.json',
);

/**
 * Zod uses the registry `id` (from `.meta({ id })`) to name `$defs`, but also
 * copies it out as a legacy draft-04 `id` keyword. Drop that schema-level
 * keyword in favour of the canonical `$id` (only at the schema root of the
 * document and each `$defs` entry — never the node `properties.id` field).
 */
function stripLegacyId(schema: object): void {
  Reflect.deleteProperty(schema, 'id');
}

/** Builds the JSON Schema document for `WorkflowDocument` (pure; no I/O). */
export function buildWorkflowJsonSchema(): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(WorkflowDocumentSchema, {
    target: 'draft-2020-12',
  });

  const document: Record<string, unknown> = {
    $id: SCHEMA_ID,
    ...jsonSchema,
  };
  stripLegacyId(document);

  const rawDefs = document.$defs;
  if (rawDefs && typeof rawDefs === 'object') {
    for (const def of Object.values(rawDefs)) {
      if (def && typeof def === 'object') {
        stripLegacyId(def);
      }
    }
  }

  return document;
}

/** Serialises the schema document exactly as it is committed to disk. */
export function serializeWorkflowJsonSchema(): string {
  return `${JSON.stringify(buildWorkflowJsonSchema(), null, 2)}\n`;
}

if (import.meta.main) {
  const document = buildWorkflowJsonSchema();
  mkdirSync(dirname(SCHEMA_OUTPUT_PATH), {
    recursive: true,
  });
  writeFileSync(SCHEMA_OUTPUT_PATH, serializeWorkflowJsonSchema());

  const defs = document.$defs;
  const defCount = defs && typeof defs === 'object' ? Object.keys(defs).length : 0;
  console.log(`Wrote ${SCHEMA_OUTPUT_PATH} (${defCount} named definitions).`);
}
