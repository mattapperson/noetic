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
 * Outputs (kept in lockstep by this one generator):
 *   - `schema/noetic-workflow.schema.json` — committed + published in the
 *     package `files` allowlist (resolved via the `./schema` export subpath).
 *   - `../web/public/schema/noetic-workflow.schema.json` — served by the site
 *     so the schema's `$id` URL actually resolves. Only written when the web
 *     package is present (i.e. in the monorepo, not a published tarball).
 *
 * A drift-gate test re-imports `buildWorkflowJsonSchema` and asserts every
 * committed copy is up to date.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { WorkflowDocumentSchema } from '../src/schemas/workflow';

/** Canonical, stable identifier for the published workflow schema (also its hosted URL). */
export const SCHEMA_ID = 'https://noetic.tools/schema/noetic-workflow.schema.json';

/** Absolute path of the committed, published schema artifact in core. */
export const SCHEMA_OUTPUT_PATH = join(
  import.meta.dir,
  '..',
  'schema',
  'noetic-workflow.schema.json',
);

/**
 * Absolute path of the static copy served by the web app at `/schema/...`,
 * so the schema's `$id` URL resolves. Lives outside the published tarball.
 */
export const WEB_SCHEMA_OUTPUT_PATH = join(
  import.meta.dir,
  '..',
  '..',
  'web',
  'public',
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

function writeSchema(path: string): void {
  mkdirSync(dirname(path), {
    recursive: true,
  });
  writeFileSync(path, serializeWorkflowJsonSchema());
  console.log(`Wrote ${path}`);
}

if (import.meta.main) {
  const document = buildWorkflowJsonSchema();
  const defs = document.$defs;
  const defCount = defs && typeof defs === 'object' ? Object.keys(defs).length : 0;

  writeSchema(SCHEMA_OUTPUT_PATH);

  // Only write the hosted copy in the monorepo, where the web app exists.
  if (existsSync(dirname(dirname(WEB_SCHEMA_OUTPUT_PATH)))) {
    writeSchema(WEB_SCHEMA_OUTPUT_PATH);
  }

  console.log(`Done (${defCount} named definitions).`);
}
