import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertWritableUnderVersionControl,
  WriteGuardError,
} from '../../src/optimization/write-guard';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'write-guard-'));
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
  return dir;
}

function commitAll(repo: string): void {
  spawnSync(
    'git',
    [
      'add',
      '.',
    ],
    {
      cwd: repo,
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
      cwd: repo,
    },
  );
}

describe('assertWritableUnderVersionControl', () => {
  it('passes for a committed, unmodified file', () => {
    const repo = makeRepo();
    const file = join(repo, 'prompt.ts');
    writeFileSync(file, 'export const p = "hello";\n');
    commitAll(repo);
    const verdicts = assertWritableUnderVersionControl([
      file,
    ]);
    expect(verdicts[0].status).toBe('clean');
  });

  it('refuses an untracked file', () => {
    const repo = makeRepo();
    const file = join(repo, 'loose.ts');
    writeFileSync(file, 'export const p = "hi";\n');
    expect(() =>
      assertWritableUnderVersionControl([
        file,
      ]),
    ).toThrow(WriteGuardError);
  });

  it('refuses a tracked file with uncommitted modifications', () => {
    const repo = makeRepo();
    const file = join(repo, 'prompt.ts');
    writeFileSync(file, 'v1');
    commitAll(repo);
    writeFileSync(file, 'v2-uncommitted');
    expect(() =>
      assertWritableUnderVersionControl([
        file,
      ]),
    ).toThrow('dirty');
  });

  it('refuses a file outside any git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'write-guard-norepo-'));
    const file = join(dir, 'prompt.ts');
    writeFileSync(file, 'x');
    try {
      assertWritableUnderVersionControl([
        file,
      ]);
      expect.unreachable('expected WriteGuardError');
    } catch (err) {
      expect(err).toBeInstanceOf(WriteGuardError);
      if (!(err instanceof WriteGuardError)) {
        throw err;
      }
      expect(err.verdicts[0].status).toBe('no-repo');
    }
  });

  it('forceDirty overrides dirty or untracked files but still reports verdicts', () => {
    const repo = makeRepo();
    const file = join(repo, 'loose.ts');
    writeFileSync(file, 'x');
    const verdicts = assertWritableUnderVersionControl(
      [
        file,
      ],
      true,
    );
    expect(verdicts[0].status).toBe('untracked');
  });

  it('forceDirty still refuses files outside a Git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'write-guard-norepo-force-'));
    const file = join(dir, 'prompt.ts');
    writeFileSync(file, 'x');
    expect(() =>
      assertWritableUnderVersionControl(
        [
          file,
        ],
        true,
      ),
    ).toThrow(WriteGuardError);
  });

  it('handles absolute paths from nested repository directories', () => {
    const repo = makeRepo();
    const nested = join(repo, 'src', 'nested');
    const file = join(nested, 'prompt.ts');
    mkdirSync(nested, {
      recursive: true,
    });
    writeFileSync(file, 'x');
    commitAll(repo);
    expect(
      assertWritableUnderVersionControl([
        file,
      ])[0].status,
    ).toBe('clean');
  });
});
