import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { callModel, runCode } from '@noetic-tools/core';

import { buildWriteBackEntries, optimize } from '../../src/optimization/optimizer';
import { WriteGuardError } from '../../src/optimization/write-guard';
import { OptimizeScope } from '../../src/types/eval';
import type { ApplyResult, OptimizableField } from '../../src/types/optimizer';
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

//#region write-back guard + coding-agent interplay

describe('optimize() write-back guard', () => {
  function makeRepo(dir: string): void {
    spawnSync(
      'git',
      [
        'init',
        '-q',
      ],
      {
        cwd: dir,
      },
    );
    spawnSync(
      'git',
      [
        'config',
        'user.email',
        't@t',
      ],
      {
        cwd: dir,
      },
    );
    spawnSync(
      'git',
      [
        'config',
        'user.name',
        't',
      ],
      {
        cwd: dir,
      },
    );
    spawnSync(
      'git',
      [
        'config',
        'commit.gpgsign',
        'false',
      ],
      {
        cwd: dir,
      },
    );
  }

  function commitAll(dir: string): void {
    spawnSync(
      'git',
      [
        'add',
        '.',
      ],
      {
        cwd: dir,
      },
    );
    spawnSync(
      'git',
      [
        'commit',
        '-qm',
        'x',
      ],
      {
        cwd: dir,
      },
    );
  }

  async function writeAgentFile(name = 'agent.ts'): Promise<{
    filePath: string;
    source: string;
    location: {
      filePath: string;
      line: number;
      column: number;
    };
  }> {
    const filePath = path.join(tmpDir, name);
    const source = "export const instructions = 'original instructions';\n";
    await fs.writeFile(filePath, source, 'utf-8');
    return {
      filePath,
      source,
      location: {
        filePath,
        line: 1,
        column: 29,
      },
    };
  }

  function makeLocatedField(location: {
    filePath: string;
    line: number;
    column: number;
  }): OptimizableField {
    return makeField({
      sourceLocation: location,
    });
  }

  /** The offline GEPA fallback never changes the candidate, so tests that need
   * a changed candidate stub the bridge (optimizer loads it via dynamic import). */
  function stubChangedCandidate(newValue = 'improved instructions'): void {
    mock.module('../../src/optimization/gepa-bridge', () => ({
      optimizeWithGepa: async () => ({
        bestCandidate: {
          'agent.instructions': newValue,
        },
        score: 1,
        iterations: 1,
      }),
    }));
  }

  afterEach(() => {
    mock.restore();
  });

  test('refuses to write back into an untracked file', async () => {
    stubChangedCandidate();
    makeRepo(tmpDir);
    const { filePath, source, location } = await writeAgentFile();
    // Deliberately NOT committed: write-back must refuse to destroy uncommitted work.

    const testStep = callModel({
      id: 'agent',
      model: 'openai/gpt-4o-mini',
      instructions: 'original instructions',
    });

    await expect(
      optimize({
        step: testStep,
        scope: OptimizeScope.PromptsOnly,
        preEnrichedFields: [
          makeLocatedField(location),
        ],
        runEval: async () => ({
          'case.scorer': 0.9,
        }),
      }),
    ).rejects.toBeInstanceOf(WriteGuardError);
    expect(await fs.readFile(filePath, 'utf-8')).toBe(source);
  });

  test('refuses to write back into a dirty tracked file', async () => {
    stubChangedCandidate();
    makeRepo(tmpDir);
    const { filePath, location } = await writeAgentFile();
    commitAll(tmpDir);
    await fs.appendFile(filePath, '// uncommitted\n', 'utf-8');

    const testStep = callModel({
      id: 'agent',
      model: 'openai/gpt-4o-mini',
      instructions: 'original instructions',
    });

    await expect(
      optimize({
        step: testStep,
        scope: OptimizeScope.PromptsOnly,
        preEnrichedFields: [
          makeLocatedField(location),
        ],
        runEval: async () => ({
          'case.scorer': 0.9,
        }),
      }),
    ).rejects.toBeInstanceOf(WriteGuardError);
  });

  test('forceDirty overrides the guard and writes back', async () => {
    stubChangedCandidate();
    makeRepo(tmpDir);
    const { filePath, location } = await writeAgentFile();

    const testStep = callModel({
      id: 'agent',
      model: 'openai/gpt-4o-mini',
      instructions: 'original instructions',
    });

    const result = await optimize({
      step: testStep,
      scope: OptimizeScope.PromptsOnly,
      preEnrichedFields: [
        makeLocatedField(location),
      ],
      forceDirty: true,
      runEval: async () => ({
        'case.scorer': 0.9,
      }),
    });

    expect(result.writtenBack).toBe(true);
    expect(await fs.readFile(filePath, 'utf-8')).toContain('improved instructions');
  });

  test('guard runs BEFORE the coding agent apply (Full scope)', async () => {
    makeRepo(tmpDir);
    const { location } = await writeAgentFile();
    // Untracked target file: the guard must fire before the agent touches anything.
    let applied = false;
    const codingAgent = {
      apply: async (): Promise<ApplyResult> => {
        applied = true;
        return {
          success: true,
          changedFiles: [],
        };
      },
    };

    const testStep = callModel({
      id: 'agent',
      model: 'openai/gpt-4o-mini',
      instructions: 'original instructions',
    });

    await expect(
      optimize({
        step: testStep,
        scope: OptimizeScope.Full,
        preEnrichedFields: [
          makeLocatedField(location),
        ],
        codingAgent,
        runEval: async () => ({
          'case.scorer': 0.9,
        }),
      }),
    ).rejects.toBeInstanceOf(WriteGuardError);
    expect(applied).toBe(false);
  });

  test('write-back skips files the coding agent just rewrote (stale locations)', async () => {
    stubChangedCandidate();
    makeRepo(tmpDir);
    const { filePath, source, location } = await writeAgentFile();
    commitAll(tmpDir);

    const codingAgent = {
      apply: async (): Promise<ApplyResult> => ({
        success: true,
        changedFiles: [
          filePath,
        ],
      }),
    };

    const testStep = callModel({
      id: 'agent',
      model: 'openai/gpt-4o-mini',
      instructions: 'original instructions',
    });

    const result = await optimize({
      step: testStep,
      scope: OptimizeScope.Full,
      preEnrichedFields: [
        makeLocatedField(location),
      ],
      codingAgent,
      runEval: async () => ({
        'case.scorer': 0.9,
      }),
    });

    expect(result.codingAgentResult?.success).toBe(true);
    expect(result.writtenBack).toBe(false);
    expect(result.writeBackReport?.written).toBe(0);
    expect(result.writeBackReport?.skipped[0].reason).toContain('stale');
    // The optimizer must not clobber the agent's rewrite with a stale splice.
    expect(await fs.readFile(filePath, 'utf-8')).toBe(source);
  });

  test('a failed coding-agent apply is surfaced, not swallowed', async () => {
    makeRepo(tmpDir);
    const { location } = await writeAgentFile();
    commitAll(tmpDir);

    const codingAgent = {
      apply: async (): Promise<ApplyResult> => ({
        success: false,
        changedFiles: [],
        error: 'agent exploded',
      }),
    };

    const testStep = callModel({
      id: 'agent',
      model: 'openai/gpt-4o-mini',
      instructions: 'original instructions',
    });

    const result = await optimize({
      step: testStep,
      scope: OptimizeScope.Full,
      preEnrichedFields: [
        makeLocatedField(location),
      ],
      codingAgent,
      runEval: async () => ({
        'case.scorer': 0.9,
      }),
    });

    expect(result.codingAgentResult).toEqual({
      success: false,
      changedFiles: [],
      error: 'agent exploded',
    });
  });
});

//#endregion
