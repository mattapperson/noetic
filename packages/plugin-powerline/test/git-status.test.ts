import { describe, expect, test } from 'bun:test';

import { parseStatus } from '../src/git-status.js';

describe('parseStatus', () => {
  test('returns null when no branch header present (not a repo)', () => {
    expect(parseStatus('')).toBeNull();
    expect(parseStatus('random output\n')).toBeNull();
  });

  test('parses branch with no changes', () => {
    const raw = [
      '# branch.oid 1234abcd',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
    ].join('\n');
    const result = parseStatus(raw);
    expect(result).toEqual({
      branch: 'main',
      staged: 0,
      unstaged: 0,
      untracked: 0,
    });
  });

  test('counts staged, unstaged, and untracked', () => {
    const raw = [
      '# branch.head feature/x',
      '1 M. N... 100644 100644 100644 aa bb path1',
      '1 .M N... 100644 100644 100644 aa bb path2',
      '1 MM N... 100644 100644 100644 aa bb path3',
      '? untracked-file.txt',
      '? another.md',
    ].join('\n');
    const result = parseStatus(raw);
    expect(result).toEqual({
      branch: 'feature/x',
      staged: 2,
      unstaged: 2,
      untracked: 2,
    });
  });

  test('falls back to HEAD when branch is detached', () => {
    const raw = [
      '# branch.head (detached)',
    ].join('\n');
    const result = parseStatus(raw);
    expect(result?.branch).toBe('(detached)');
  });
});
