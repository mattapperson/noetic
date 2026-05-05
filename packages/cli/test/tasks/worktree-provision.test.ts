import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';

import type { ShellAdapter, ShellExecResult } from '@noetic/core';

import {
  ProvisionTool,
  provisionWorktree,
  WorktreeProvisionError,
} from '@noetic/code-agent/tasks';

//#region Fake shell helpers

interface RecordedCall {
  readonly command: string;
  readonly cwd: string;
}

interface FakeShellOptions {
  /**
   * Map of command-prefix → fixed result. The first entry whose prefix
   * matches the input command wins. Throws when no entry matches so
   * tests catch unexpected calls.
   */
  readonly responses: ReadonlyArray<{
    readonly prefix: string;
    readonly result: ShellExecResult | (() => ShellExecResult | Promise<ShellExecResult>);
    readonly throws?: Error;
  }>;
}

function makeFakeShell(opts: FakeShellOptions): {
  shell: ShellAdapter;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const shell: ShellAdapter = {
    exec: async (command, options) => {
      calls.push({
        command,
        cwd: options.cwd,
      });
      const match = opts.responses.find((r) => command.startsWith(r.prefix));
      if (match === undefined) {
        throw new Error(`Unexpected command in test: ${command}`);
      }
      if (match.throws !== undefined) {
        throw match.throws;
      }
      const result = typeof match.result === 'function' ? match.result() : match.result;
      return result instanceof Promise ? await result : result;
    },
  };
  return {
    shell,
    calls,
  };
}

function ok(stdout = ''): ShellExecResult {
  return {
    stdout,
    stderr: '',
    exitCode: 0,
  };
}

function failed(exit: number, stderr: string): ShellExecResult {
  return {
    stdout: '',
    stderr,
    exitCode: exit,
  };
}

function porcelainListing(
  records: ReadonlyArray<{
    path: string;
    branch: string;
  }>,
): string {
  const blocks = records.map(
    (r) =>
      `worktree ${r.path}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/${r.branch}\n`,
  );
  return blocks.join('\n');
}

//#endregion

describe('provisionWorktree', () => {
  it('reuses an existing worktree when the branch already has one', async () => {
    const projectRoot = '/repo';
    const branch = 'feat/x';
    const existingPath = '/repo/.worktrees/feat-x';
    const { shell, calls } = makeFakeShell({
      responses: [
        {
          prefix: 'git worktree list --porcelain',
          result: ok(
            porcelainListing([
              {
                path: '/repo',
                branch: 'main',
              },
              {
                path: existingPath,
                branch,
              },
            ]),
          ),
        },
      ],
    });
    const result = await provisionWorktree({
      projectRoot,
      branch,
      shell,
    });
    expect(result).toEqual({
      worktreePath: existingPath,
      branch,
      tool: ProvisionTool.Reused,
    });
    // Only the discovery call ran — no wt, no git worktree add.
    expect(calls).toHaveLength(1);
  });

  it('happy path: wt switch -c creates a worktree and we resolve its path via git worktree list', async () => {
    const projectRoot = '/repo';
    const branch = 'feat/wt-happy';
    const wtCreatedPath = '/Users/me/.wt/worktrees/feat-wt-happy';
    let porcelainCallCount = 0;
    const { shell, calls } = makeFakeShell({
      responses: [
        {
          prefix: 'git worktree list --porcelain',
          result: () => {
            porcelainCallCount += 1;
            // First call (existence check): no match. Second call (post-wt): match.
            if (porcelainCallCount === 1) {
              return ok(
                porcelainListing([
                  {
                    path: projectRoot,
                    branch: 'main',
                  },
                ]),
              );
            }
            return ok(
              porcelainListing([
                {
                  path: projectRoot,
                  branch: 'main',
                },
                {
                  path: wtCreatedPath,
                  branch,
                },
              ]),
            );
          },
        },
        {
          prefix: 'wt switch -c',
          result: ok(),
        },
      ],
    });
    const result = await provisionWorktree({
      projectRoot,
      branch,
      shell,
    });
    expect(result).toEqual({
      worktreePath: wtCreatedPath,
      branch,
      tool: ProvisionTool.Wt,
    });
    expect(calls.map((c) => c.command)).toEqual([
      'git worktree list --porcelain',
      `wt switch -c ${branch}`,
      'git worktree list --porcelain',
    ]);
  });

  it('falls back to git worktree add when wt is missing (exit 127)', async () => {
    const projectRoot = '/repo';
    const branch = 'feat/git-fallback';
    const { shell, calls } = makeFakeShell({
      responses: [
        {
          prefix: 'git worktree list --porcelain',
          result: ok(
            porcelainListing([
              {
                path: projectRoot,
                branch: 'main',
              },
            ]),
          ),
        },
        {
          prefix: 'wt switch -c',
          result: failed(127, 'wt: command not found'),
        },
        {
          prefix: 'git worktree add',
          result: ok(),
        },
      ],
    });
    const result = await provisionWorktree({
      projectRoot,
      branch,
      shell,
    });
    expect(result).toEqual({
      worktreePath: '/repo/.worktrees/feat/git-fallback',
      branch,
      tool: ProvisionTool.Git,
    });
    expect(calls.map((c) => c.command)).toEqual([
      'git worktree list --porcelain',
      `wt switch -c ${branch}`,
      `git worktree add /repo/.worktrees/feat/git-fallback -b ${branch}`,
    ]);
  });

  it('falls back to git worktree add when shell.exec throws ENOENT for wt', async () => {
    const projectRoot = '/repo';
    const branch = 'feat/wt-enoent';
    const enoentError = Object.assign(new Error('spawn wt ENOENT'), {
      code: 'ENOENT',
    });
    const { shell } = makeFakeShell({
      responses: [
        {
          prefix: 'git worktree list --porcelain',
          result: ok(
            porcelainListing([
              {
                path: projectRoot,
                branch: 'main',
              },
            ]),
          ),
        },
        {
          prefix: 'wt switch -c',
          result: ok(),
          throws: enoentError,
        },
        {
          prefix: 'git worktree add',
          result: ok(),
        },
      ],
    });
    const result = await provisionWorktree({
      projectRoot,
      branch,
      shell,
    });
    expect(result.tool).toBe(ProvisionTool.Git);
    expect(result.worktreePath).toBe('/repo/.worktrees/feat/wt-enoent');
  });

  it('throws WorktreeProvisionError when both wt and git fail', async () => {
    const projectRoot = '/repo';
    const branch = 'feat/both-fail';
    const { shell } = makeFakeShell({
      responses: [
        {
          prefix: 'git worktree list --porcelain',
          result: ok(
            porcelainListing([
              {
                path: projectRoot,
                branch: 'main',
              },
            ]),
          ),
        },
        {
          prefix: 'wt switch -c',
          result: failed(127, 'wt: command not found'),
        },
        {
          prefix: 'git worktree add',
          result: failed(128, 'fatal: invalid reference: feat/both-fail'),
        },
      ],
    });
    let caught: unknown;
    try {
      await provisionWorktree({
        projectRoot,
        branch,
        shell,
      });
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof WorktreeProvisionError);
    expect(caught.wtResult?.exitCode).toBe(127);
    expect(caught.gitResult?.exitCode).toBe(128);
    expect(caught.message).toContain('not found on PATH');
    expect(caught.message).toContain('git worktree add failed');
    // Standard ES2022 cause field is set so loggers and stack-trace
    // serialisers see the underlying shell results.
    expect(caught.cause).toEqual({
      wtResult: caught.wtResult,
      gitResult: caught.gitResult,
    });
  });

  it('falls through to git when wt reports success but git worktree list cannot see the new worktree', async () => {
    // Defensive path: wt exited 0 but the porcelain output is missing
    // the branch (e.g. wt created the worktree somewhere git can't
    // see). We must not silently lose the branch.
    const projectRoot = '/repo';
    const branch = 'feat/wt-lies';
    let porcelainCalls = 0;
    const { shell, calls } = makeFakeShell({
      responses: [
        {
          prefix: 'git worktree list --porcelain',
          result: () => {
            porcelainCalls += 1;
            return ok(
              porcelainListing([
                {
                  path: projectRoot,
                  branch: 'main',
                },
              ]),
            );
          },
        },
        {
          prefix: 'wt switch -c',
          result: ok(),
        },
        {
          prefix: 'git worktree add',
          result: ok(),
        },
      ],
    });
    const result = await provisionWorktree({
      projectRoot,
      branch,
      shell,
    });
    expect(porcelainCalls).toBeGreaterThanOrEqual(2);
    expect(result.tool).toBe(ProvisionTool.Git);
    expect(result.worktreePath).toBe('/repo/.worktrees/feat/wt-lies');
    expect(calls.some((c) => c.command.startsWith('git worktree add'))).toBe(true);
  });

  it('uses cwd override for shell.exec when supplied', async () => {
    const projectRoot = '/repo';
    const branch = 'feat/cwd';
    const overrideCwd = '/different/cwd';
    const { shell, calls } = makeFakeShell({
      responses: [
        {
          prefix: 'git worktree list --porcelain',
          result: ok(
            porcelainListing([
              {
                path: '/different/cwd',
                branch,
              },
            ]),
          ),
        },
      ],
    });
    await provisionWorktree({
      projectRoot,
      branch,
      shell,
      cwd: overrideCwd,
    });
    expect(calls[0]?.cwd).toBe(overrideCwd);
  });

  it('rejects branch names containing shell metacharacters before any shell call', async () => {
    // The local shell adapter passes commands through `sh -c`, so any
    // metacharacter in the branch name is a command-injection risk.
    // The guard must run BEFORE any shell call, so we assert via a
    // shell that throws on every invocation.
    const explodingShell: ShellAdapter = {
      exec: async () => {
        throw new Error('shell should not be reached');
      },
    };
    const dangerous = [
      'feat/x; rm -rf /',
      'feat/x && echo pwned',
      'feat/x | cat',
      'feat/x`whoami`',
      'feat/x$(whoami)',
      'feat with space',
      '../../etc/passwd',
      '-flag',
      'feat/x..y',
      'feat/',
      'feat//x',
      '',
    ];
    for (const branch of dangerous) {
      let caught: unknown;
      try {
        await provisionWorktree({
          projectRoot: '/repo',
          branch,
          shell: explodingShell,
        });
      } catch (err) {
        caught = err;
      }
      assert(
        caught instanceof WorktreeProvisionError,
        `expected WorktreeProvisionError for ${JSON.stringify(branch)}, got ${String(caught)}`,
      );
      expect(caught.message).toContain('unsafe branch name');
    }
  });

  it('accepts standard branch names with slashes, dots, hyphens, and underscores', async () => {
    const projectRoot = '/repo';
    const safe = [
      'main',
      'feat/x',
      'feat/x-y',
      'feat/x.y',
      'feat_x',
      'release/1.2.3',
    ];
    for (const branch of safe) {
      const { shell } = makeFakeShell({
        responses: [
          {
            prefix: 'git worktree list --porcelain',
            result: ok(
              porcelainListing([
                {
                  path: `/repo/.worktrees/${branch}`,
                  branch,
                },
              ]),
            ),
          },
        ],
      });
      const result = await provisionWorktree({
        projectRoot,
        branch,
        shell,
      });
      expect(result.tool).toBe(ProvisionTool.Reused);
      expect(result.branch).toBe(branch);
    }
  });
});
