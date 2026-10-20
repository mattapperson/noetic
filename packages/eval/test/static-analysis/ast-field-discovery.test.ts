import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { discoverFieldsFromSource } from '../../src/static-analysis/ast-field-discovery';
import type { OptimizableField } from '../../src/types/optimizer';
import { FieldKind } from '../../src/types/optimizer';

/**
 * `tool()` is gated by `BUILDER_NAMES`, so dropping it there makes
 * `processToolBuilderCall` unreachable and silently discovers zero tool
 * name/description fields — the values spec 17 lists as L1-optimizable.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ast-field-discovery-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, {
    recursive: true,
    force: true,
  });
});

//#region Helper Functions

/**
 * Discovery deliberately walks only the files the eval *imports*, never the
 * eval file itself, so every fixture needs both halves on disk.
 */
async function discoverFrom(agentSource: string): Promise<OptimizableField[]> {
  const agentPath = path.join(tmpDir, 'agent.ts');
  const evalPath = path.join(tmpDir, 'suite.eval.ts');
  await fs.writeFile(agentPath, agentSource, 'utf-8');
  await fs.writeFile(
    evalPath,
    "import { agent } from './agent';\n\nexport default agent;\n",
    'utf-8',
  );
  return discoverFieldsFromSource(evalPath);
}

function fieldAt(fields: OptimizableField[], fieldPath: string): OptimizableField | undefined {
  return fields.find((f) => f.path === fieldPath);
}

/** The literal the recorded 1-based line/column actually points at. */
function textAt(source: string, field: OptimizableField): string {
  const loc = field.sourceLocation;
  assert(loc, `expected a source location for ${field.path}`);
  const line = source.split('\n')[loc.line - 1];
  assert(line !== undefined, `line ${loc.line} is outside the fixture`);
  return line.slice(loc.column - 1);
}

//#endregion

//#region Fixtures

const SEARCH_DESCRIPTION = 'Search the web for a query.';

const AGENT_WITH_TOOL = `import { callModel, tool } from '@noetic-tools/core';
import { z } from 'zod';

export const searchTool = tool({
  name: 'search',
  description: '${SEARCH_DESCRIPTION}',
  input: z.object({ query: z.string() }),
  output: z.string(),
  execute: async ({ query }) => query,
});

export const agent = callModel({
  id: 'researcher',
  model: 'openai/gpt-4o-mini',
  instructions: 'Answer the question using the search tool.',
  tools: [searchTool],
});
`;

//#endregion

describe('discoverFieldsFromSource tool() discovery', () => {
  test("discovers a tool()'s description as an optimizable field", async () => {
    const fields = await discoverFrom(AGENT_WITH_TOOL);

    const description = fieldAt(fields, 'search.description');
    assert(description, 'tool description was not discovered');
    expect(description.value).toBe(SEARCH_DESCRIPTION);
    expect(description.fieldKind).toBe(FieldKind.ToolDescription);
    expect(description.stepId).toBe('search');
  });

  test("discovers a tool()'s name as an optimizable field", async () => {
    const fields = await discoverFrom(AGENT_WITH_TOOL);

    const name = fieldAt(fields, 'search.name');
    assert(name, 'tool name was not discovered');
    expect(name.value).toBe('search');
    expect(name.fieldKind).toBe(FieldKind.ToolName);
    expect(name.stepId).toBe('search');
  });

  test('records source locations that land on the string literals, so write-back can patch them', async () => {
    const fields = await discoverFrom(AGENT_WITH_TOOL);

    const description = fieldAt(fields, 'search.description');
    const name = fieldAt(fields, 'search.name');
    assert(description, 'tool description was not discovered');
    assert(name, 'tool name was not discovered');

    expect(textAt(AGENT_WITH_TOOL, description)).toBe(`'${SEARCH_DESCRIPTION}',`);
    expect(textAt(AGENT_WITH_TOOL, name)).toBe("'search',");
  });

  test('a tool() without a name contributes nothing rather than an unnamed field', async () => {
    const fields = await discoverFrom(
      `import { tool } from '@noetic-tools/core';

export const agent = tool({
  description: 'A tool whose name is computed elsewhere.',
});
`,
    );

    expect(fields).toEqual([]);
  });

  test('still discovers the sibling callModel fields alongside the tool fields', async () => {
    const fields = await discoverFrom(AGENT_WITH_TOOL);

    const instructions = fieldAt(fields, 'researcher.instructions');
    assert(instructions, 'callModel instructions were not discovered');
    expect(instructions.value).toBe('Answer the question using the search tool.');
    expect(instructions.fieldKind).toBe(FieldKind.Instructions);

    // The `tools: [...]` array records each reference by identifier, which is a
    // separate path from the `tool()` definition's own `search.name`.
    const reference = fieldAt(fields, 'researcher.tools.searchTool');
    assert(reference, 'tool reference in the tools array was not discovered');
    expect(reference.fieldKind).toBe(FieldKind.ToolName);
  });
});
