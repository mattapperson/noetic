import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { discoverEvalFiles } from '../../src/cli/file-discovery';

let tmpDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-discovery-'));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, {
    recursive: true,
    force: true,
  });
});

describe('discoverEvalFiles', () => {
  test('resolves explicit existing files', () => {
    const fp = path.join(tmpDir, 'agent.eval.ts');
    fs.writeFileSync(fp, '// eval', 'utf-8');

    const discovery = discoverEvalFiles([
      fp,
    ]);
    expect(discovery.files).toEqual([
      fp,
    ]);
    expect(discovery.unresolved).toHaveLength(0);
  });

  test('resolves bare names by appending .eval.ts', () => {
    fs.writeFileSync(path.join(tmpDir, 'agent.eval.ts'), '// eval', 'utf-8');

    const discovery = discoverEvalFiles([
      'agent',
    ]);
    expect(discovery.files).toHaveLength(1);
    expect(discovery.files[0].endsWith('agent.eval.ts')).toBe(true);
  });

  test('surfaces unresolvable explicit patterns instead of dropping them', () => {
    fs.writeFileSync(path.join(tmpDir, 'agent.eval.ts'), '// eval', 'utf-8');

    const discovery = discoverEvalFiles([
      'agent',
      'no-such-eval',
    ]);
    expect(discovery.files).toHaveLength(1);
    expect(discovery.unresolved).toEqual([
      'no-such-eval',
    ]);
  });

  test('walks cwd when no patterns are given; empty result is not unresolved', () => {
    const discovery = discoverEvalFiles([]);
    expect(discovery.files).toEqual([]);
    expect(discovery.unresolved).toEqual([]);
  });
});
