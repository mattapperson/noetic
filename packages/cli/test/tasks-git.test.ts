import { describe, expect, test } from 'bun:test';

import type { GitCommandRunner } from '../src/commands/builtins/tasks/git.js';
import {
  loadProjectWorktreesWithGit,
  parseWorktreeList,
} from '../src/commands/builtins/tasks/git.js';

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

describe('loadProjectWorktreesWithGit', () => {
  test('excludes the main worktree from the returned list', async () => {
    const git: GitCommandRunner = async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return '/repo';
      }
      return [
        'worktree /repo',
        'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'branch refs/heads/main',
        '',
        'worktree /repo-feature',
        'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'branch refs/heads/feature',
        '',
      ].join('\n');
    };

    const worktrees = await loadProjectWorktreesWithGit('/repo', git);

    expect(worktrees.map((worktree) => worktree.path)).toEqual([
      '/repo-feature',
    ]);
    expect(worktrees[0]?.projectRoot).toBe('/repo');
    expect(worktrees[0]?.current).toBe(false);
  });
});
