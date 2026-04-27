import { describe, expect, test } from 'bun:test';

import { parseWorktreeList } from '../src/commands/builtins/tasks/git.js';

describe('parseWorktreeList', () => {
  test('parses porcelain records with branches and detached worktrees', () => {
    const records = parseWorktreeList(`worktree /repo
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/main

worktree /repo-feature
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/feature/pr-review

worktree /repo-detached
HEAD cccccccccccccccccccccccccccccccccccccccc
detached
`);

    expect(records).toEqual([
      {
        path: '/repo',
        headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        prunable: false,
      },
      {
        path: '/repo-feature',
        headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        branchRef: 'refs/heads/feature/pr-review',
        detached: false,
        bare: false,
        prunable: false,
      },
      {
        path: '/repo-detached',
        headSha: 'cccccccccccccccccccccccccccccccccccccccc',
        branchRef: null,
        detached: true,
        bare: false,
        prunable: false,
      },
    ]);
  });
});
