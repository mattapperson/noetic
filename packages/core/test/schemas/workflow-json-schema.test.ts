import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildWorkflowJsonSchema,
  SCHEMA_ID,
  SCHEMA_OUTPUT_PATH,
  serializeWorkflowJsonSchema,
  WEB_SCHEMA_OUTPUT_PATH,
} from '../../scripts/generate-workflow-schema';
import { validateWorkflow } from '../../src/schemas/workflow';

/** Every JSON-serialisable node kind the runtime accepts. */
const NODE_KINDS = [
  'llm',
  'tool',
  'branch',
  'fork',
  'spawn',
  'provide',
  'loop',
  'sequence',
  'every',
  'claude-code',
  'codex',
  'opencode',
  'pi',
] as const;

/** Every named until predicate kind the runtime accepts. */
const UNTIL_KINDS = [
  'maxSteps',
  'maxCost',
  'maxDuration',
  'noToolCalls',
  'outputContains',
  'outputEquals',
  'converged',
  'any',
  'all',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Collects the `kind` const of each variant under a `oneOf`/`anyOf` branch. */
function variantKinds(def: unknown): string[] {
  if (!isRecord(def)) {
    return [];
  }
  const branches = def.oneOf ?? def.anyOf;
  if (!Array.isArray(branches)) {
    return [];
  }
  const kinds: string[] = [];
  for (const branch of branches) {
    if (!isRecord(branch)) {
      continue;
    }
    const properties = branch.properties;
    if (!isRecord(properties)) {
      continue;
    }
    const kind = properties.kind;
    if (isRecord(kind) && typeof kind.const === 'string') {
      kinds.push(kind.const);
    }
  }
  return kinds;
}

describe('published workflow JSON Schema', () => {
  test('committed artifact is up to date with the Zod source', () => {
    const committed = readFileSync(SCHEMA_OUTPUT_PATH, 'utf8');
    expect(committed).toBe(serializeWorkflowJsonSchema());
  });

  test('hosted web copy is byte-identical to the published artifact', () => {
    const hosted = readFileSync(WEB_SCHEMA_OUTPUT_PATH, 'utf8');
    expect(hosted).toBe(serializeWorkflowJsonSchema());
  });

  test('declares draft-2020-12 and the canonical $id', () => {
    const schema = buildWorkflowJsonSchema();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe(SCHEMA_ID);
  });

  test('does not leak the legacy draft-04 id keyword', () => {
    const schema = buildWorkflowJsonSchema();
    expect('id' in schema).toBe(false);
    const defs = schema.$defs;
    assertRecord(defs);
    for (const def of Object.values(defs)) {
      assertRecord(def);
      expect('id' in def).toBe(false);
    }
  });

  test('WorkflowNode variants match every runtime node kind', () => {
    const schema = buildWorkflowJsonSchema();
    const defs = schema.$defs;
    assertRecord(defs);
    expect(variantKinds(defs.WorkflowNode).sort()).toEqual(
      [
        ...NODE_KINDS,
      ].sort(),
    );
  });

  test('UntilPredicate variants match every runtime predicate kind', () => {
    const schema = buildWorkflowJsonSchema();
    const defs = schema.$defs;
    assertRecord(defs);
    expect(variantKinds(defs.UntilPredicate).sort()).toEqual(
      [
        ...UNTIL_KINDS,
      ].sort(),
    );
  });

  test('the published example document validates against the Zod source', () => {
    const example = JSON.parse(
      readFileSync(
        join(SCHEMA_OUTPUT_PATH, '..', '..', 'examples', 'multi-model-judge.workflow.json'),
        'utf8',
      ),
    );
    const doc = validateWorkflow(example);
    expect(doc.version).toBe(1);
    expect(doc.root.kind).toBe('sequence');
  });
});

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Expected a record');
  }
}
