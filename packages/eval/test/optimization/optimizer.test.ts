import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { callModel, runCode } from '@noetic-tools/core';

import { buildWriteBackEntries, optimize } from '../../src/optimization/optimizer';
import { OptimizeScope } from '../../src/types/eval';
import type { OptimizableField } from '../../src/types/optimizer';
import { FieldKind } from '../../src/types/optimizer';

let tmpDir: string;
let savedOpenrouterApiKey: string | undefined;
let savedNoeticApiKey: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optimizer-'));
  savedOpenrouterApiKey = process.env.OPENROUTER_API_KEY;
  savedNoeticApiKey = process.env.NOETIC_API_KEY;
  // Force the offline GEPA fallback (evaluate initial candidate once). BOTH keys
  // must be cleared — `optimizeWithGepa` accepts either provider, so leaving one
  // set would send these tests to a live endpoint.
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.NOETIC_API_KEY;
});

afterEach(async () => {
  if (savedOpenrouterApiKey !== undefined) {
    process.env.OPENROUTER_API_KEY = savedOpenrouterApiKey;
  }
  if (savedNoeticApiKey !== undefined) {
    process.env.NOETIC_API_KEY = savedNoeticApiKey;
  }
  await fs.rm(tmpDir, {
    recursive: true,
    force: true,
  });
});

function makeField(overrides: Partial<OptimizableField> = {}): OptimizableField {
  return {
    path: 'agent.instructions',
    value: 'original instructions',
    stepId: 'agent',
    fieldKind: FieldKind.Instructions,
    ...overrides,
  };
}

//#region buildWriteBackEntries

describe('buildWriteBackEntries', () => {
  const location = {
    filePath: '/tmp/agent.ts',
    line: 3,
    column: 18,
  };

  test('unchanged candidate values produce no entries', () => {
    const field = makeField({
      sourceLocation: location,
    });
    const entries = buildWriteBackEntries(
      [
        field,
      ],
      {
        'agent.instructions': 'original instructions',
      },
    );
    expect(entries).toHaveLength(0);
  });

  test('changed values produce entries carrying expectedValue', () => {
    const field = makeField({
      sourceLocation: location,
    });
    const entries = buildWriteBackEntries(
      [
        field,
      ],
      {
        'agent.instructions': 'improved instructions',
      },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].newValue).toBe('improved instructions');
    expect(entries[0].expectedValue).toBe('original instructions');
    expect(entries[0].sourceLocation).toEqual(location);
  });

  test('fields without sourceLocation are excluded', () => {
    const entries = buildWriteBackEntries(
      [
        makeField(),
      ],
      {
        'agent.instructions': 'improved instructions',
      },
    );
    expect(entries).toHaveLength(0);
  });

  test('fields missing from the candidate are excluded', () => {
    const entries = buildWriteBackEntries(
      [
        makeField({
          sourceLocation: location,
        }),
      ],
      {},
    );
    expect(entries).toHaveLength(0);
  });
});

//#endregion

//#region optimize() write-back semantics

describe('optimize() write-back semantics', () => {
  test('offline fallback returns initial candidate: writtenBack false, source untouched', async () => {
    const agentFile = path.join(tmpDir, 'agent.ts');
    const source = "export const instructions = 'original instructions';";
    await fs.writeFile(agentFile, source, 'utf-8');

    const testStep = callModel({
      id: 'agent',
      model: 'openai/gpt-4o-mini',
      instructions: 'original instructions',
    });

    const result = await optimize({
      step: testStep,
      scope: OptimizeScope.PromptsOnly,
      preEnrichedFields: [
        makeField({
          sourceLocation: {
            filePath: agentFile,
            line: 1,
            column: 29,
          },
        }),
      ],
      runEval: async () => ({
        'case.scorer': 0.9,
      }),
    });

    expect(result.writtenBack).toBe(false);
    expect(result.writeBackReport).toBeUndefined();
    expect(result.bestCandidate['agent.instructions']).toBe('original instructions');
    const after = await fs.readFile(agentFile, 'utf-8');
    expect(after).toBe(source);
  });

  test('no optimizable fields short-circuits with writtenBack false', async () => {
    const testStep = runCode({
      id: 'noop',
      execute: async (input: unknown) => input,
    });

    const result = await optimize({
      step: testStep,
      scope: OptimizeScope.PromptsOnly,
      runEval: async () => ({}),
    });

    expect(result.fields).toHaveLength(0);
    expect(result.writtenBack).toBe(false);
    expect(result.iterations).toBe(0);
  });
});

//#endregion
