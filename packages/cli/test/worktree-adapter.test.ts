import { describe, expect, test } from 'bun:test';
import type { ShellAdapter, ShellExecOptions, ShellExecResult } from '@noetic/core';
import { isNoeticConfigError } from '@noetic/core';
import { createAgentWorktree } from '../src/adapters/worktree.js';

//#region Mock shell

interface ExecCall {
  command: string;
  cwd: string;
}

interface MockShellProgramming {
  /**
   * Map from a substring match (e.g. `'symbolic-ref'`) to the result. The
   * first key whose substring appears in the executed command wins. Falls
   * through to `default` if none match.
   */
  rules: Array<
    [
      string,
      Partial<ShellExecResult>,
    ]
  >;
  default?: Partial<ShellExecResult>;
}

function fillResult(partial: Partial<ShellExecResult>): ShellExecResult {
  return {
    stdout: partial.stdout ?? '',
    stderr: partial.stderr ?? '',
    exitCode: partial.exitCode ?? 0,
  };
}

function createMockShell(programming: MockShellProgramming): {
  shell: ShellAdapter;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const shell: ShellAdapter = {
    exec(command: string, options: ShellExecOptions): Promise<ShellExecResult> {
      calls.push({
        command,
        cwd: options.cwd,
      });
      for (const [pattern, result] of programming.rules) {
        if (command.includes(pattern)) {
          return Promise.resolve(fillResult(result));
        }
      }
      return Promise.resolve(
        fillResult(
          programming.default ?? {
            exitCode: 0,
          },
        ),
      );
    },
  };
  return {
    shell,
    calls,
  };
}

//#endregion

//#region Common programming helpers

/**
 * Default programming that walks `createAgentWorktree` through a happy path:
 *   - show-toplevel → /repo
 *   - symbolic-ref origin/HEAD → main
 *   - worktree add → success
 *   - status --porcelain → clean
 *   - rev-list → 0 commits beyond base
 *   - worktree remove → success
 */
function happyPathProgramming(): MockShellProgramming {
  return {
    rules: [
      [
        'rev-parse --show-toplevel',
        {
          stdout: '/repo',
        },
      ],
      [
        'symbolic-ref refs/remotes/origin/HEAD',
        {
          stdout: 'origin/main',
        },
      ],
      [
        'worktree add',
        {
          exitCode: 0,
        },
      ],
      [
        'status --porcelain',
        {
          stdout: '',
        },
      ],
      [
        'rev-list --count',
        {
          stdout: '0',
        },
      ],
      [
        'worktree remove',
        {
          exitCode: 0,
        },
      ],
    ],
    default: {
      exitCode: 0,
    },
  };
}

//#endregion

describe('gitDefaultBranch (via createAgentWorktree fallback order)', () => {
  test('uses origin/HEAD when available', async () => {
    const { shell, calls } = createMockShell(happyPathProgramming());
    const wt = await createAgentWorktree({
      agentId: 'agent-1',
      cwd: '/repo',
      shell,
      config: undefined,
    });
    // Verify: origin/HEAD call came before init.defaultBranch and show-ref.
    const firstDefaultBranchCall = calls.findIndex((c) =>
      c.command.includes('symbolic-ref refs/remotes/origin/HEAD'),
    );
    const configCall = calls.findIndex((c) =>
      c.command.includes('config --get init.defaultBranch'),
    );
    expect(firstDefaultBranchCall).toBeGreaterThanOrEqual(0);
    expect(configCall).toBe(-1); // never got to this fallback
    expect(wt.branch).toContain('agent-1');
  });

  test('falls back to init.defaultBranch when origin/HEAD missing', async () => {
    const { shell, calls } = createMockShell({
      rules: [
        [
          'rev-parse --show-toplevel',
          {
            stdout: '/repo',
          },
        ],
        [
          'symbolic-ref refs/remotes/origin/HEAD',
          {
            exitCode: 1,
            stderr: 'fatal: no such ref',
          },
        ],
        [
          'config --get init.defaultBranch',
          {
            stdout: 'trunk',
          },
        ],
        [
          'worktree add',
          {
            exitCode: 0,
          },
        ],
      ],
      default: {
        exitCode: 0,
      },
    });
    const wt = await createAgentWorktree({
      agentId: 'agent-2',
      cwd: '/repo',
      shell,
      config: undefined,
      defaultCleanup: 'never',
    });
    expect(wt.branch).toContain('agent-2');
    const addCall = calls.find((c) => c.command.includes('worktree add'));
    expect(addCall?.command).toContain("'trunk'");
  });

  test('throws WORKTREE_NO_DEFAULT_BRANCH when all fallbacks fail', async () => {
    const { shell } = createMockShell({
      rules: [
        [
          'rev-parse --show-toplevel',
          {
            stdout: '/repo',
          },
        ],
      ],
      default: {
        exitCode: 1,
        stderr: 'not found',
      },
    });
    try {
      await createAgentWorktree({
        agentId: 'agent-3',
        cwd: '/repo',
        shell,
        config: undefined,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(isNoeticConfigError(e)).toBe(true);
      if (isNoeticConfigError(e)) {
        expect(e.code).toBe('WORKTREE_NO_DEFAULT_BRANCH');
      }
    }
  });
});

describe('gitRepoPath', () => {
  test('throws WORKTREE_NOT_GIT_REPO when not in a repo', async () => {
    const { shell } = createMockShell({
      rules: [
        [
          'rev-parse --show-toplevel',
          {
            exitCode: 128,
            stderr: 'fatal: not a git repo',
          },
        ],
      ],
    });
    try {
      await createAgentWorktree({
        agentId: 'agent-a',
        cwd: '/not-a-repo',
        shell,
        config: undefined,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(isNoeticConfigError(e)).toBe(true);
      if (isNoeticConfigError(e)) {
        expect(e.code).toBe('WORKTREE_NOT_GIT_REPO');
      }
    }
  });
});

describe('gitWorktreeAdd', () => {
  test('throws WORKTREE_ADD_FAILED on nonzero exit', async () => {
    const programming = happyPathProgramming();
    programming.rules = programming.rules.map(([pattern, result]) => {
      if (pattern === 'worktree add') {
        return [
          pattern,
          {
            exitCode: 128,
            stderr: 'branch already exists',
          },
        ];
      }
      return [
        pattern,
        result,
      ];
    });
    const { shell } = createMockShell(programming);
    try {
      await createAgentWorktree({
        agentId: 'agent-b',
        cwd: '/repo',
        shell,
        config: undefined,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(isNoeticConfigError(e)).toBe(true);
      if (isNoeticConfigError(e)) {
        expect(e.code).toBe('WORKTREE_ADD_FAILED');
        expect(e.message).toContain('branch already exists');
      }
    }
  });
});

describe('pre-start hook failure tears down the worktree (no leak)', () => {
  test('hook failure triggers worktree remove + throws WORKTREE_HOOK_FAILED', async () => {
    const programming = happyPathProgramming();
    programming.rules.unshift([
      'echo fail',
      {
        exitCode: 1,
        stderr: 'boom',
      },
    ]);
    const { shell, calls } = createMockShell(programming);
    try {
      await createAgentWorktree({
        agentId: 'agent-h',
        cwd: '/repo',
        shell,
        config: {
          'pre-start': 'echo fail',
        },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(isNoeticConfigError(e)).toBe(true);
      if (isNoeticConfigError(e)) {
        expect(e.code).toBe('WORKTREE_HOOK_FAILED');
      }
    }
    // The adapter should have cleaned up after itself.
    const removeCalls = calls.filter((c) => c.command.includes('worktree remove'));
    expect(removeCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('cleanup modes', () => {
  test("'never' retains the worktree", async () => {
    const { shell, calls } = createMockShell(happyPathProgramming());
    const wt = await createAgentWorktree({
      agentId: 'agent-n',
      cwd: '/repo',
      shell,
      config: {
        cleanup: 'never',
      },
    });
    const res = await wt.cleanup();
    expect(res.removed).toBe(false);
    expect(res.retainedAt).toBe(wt.worktreePath);
    expect(calls.filter((c) => c.command.includes('worktree remove'))).toHaveLength(0);
  });

  test("'always' removes even when dirty", async () => {
    const programming = happyPathProgramming();
    programming.rules = programming.rules.map(([p, r]) => {
      if (p === 'status --porcelain') {
        return [
          p,
          {
            stdout: ' M dirty-file',
          },
        ];
      }
      return [
        p,
        r,
      ];
    });
    const { shell, calls } = createMockShell(programming);
    const wt = await createAgentWorktree({
      agentId: 'agent-a',
      cwd: '/repo',
      shell,
      config: {
        cleanup: 'always',
      },
    });
    const res = await wt.cleanup();
    expect(res.removed).toBe(true);
    expect(calls.filter((c) => c.command.includes('worktree remove'))).toHaveLength(1);
  });

  test("'if-clean' retains when status is dirty", async () => {
    const programming = happyPathProgramming();
    programming.rules = programming.rules.map(([p, r]) => {
      if (p === 'status --porcelain') {
        return [
          p,
          {
            stdout: ' M dirty-file',
          },
        ];
      }
      return [
        p,
        r,
      ];
    });
    const { shell } = createMockShell(programming);
    const wt = await createAgentWorktree({
      agentId: 'agent-c',
      cwd: '/repo',
      shell,
      config: {
        cleanup: 'if-clean',
      },
    });
    const res = await wt.cleanup();
    expect(res.removed).toBe(false);
    expect(res.retainedAt).toBe(wt.worktreePath);
  });

  test("'if-clean' retains when rev-list count fails (refuses to delete)", async () => {
    const programming = happyPathProgramming();
    programming.rules = programming.rules.map(([p, r]) => {
      if (p === 'rev-list --count') {
        return [
          p,
          {
            exitCode: 1,
            stderr: 'unknown revision',
          },
        ];
      }
      return [
        p,
        r,
      ];
    });
    const { shell } = createMockShell(programming);
    const wt = await createAgentWorktree({
      agentId: 'agent-u',
      cwd: '/repo',
      shell,
      config: {
        cleanup: 'if-clean',
      },
    });
    const res = await wt.cleanup();
    expect(res.removed).toBe(false);
  });

  test('cleanup is idempotent — second call is a no-op', async () => {
    const { shell, calls } = createMockShell(happyPathProgramming());
    const wt = await createAgentWorktree({
      agentId: 'agent-i',
      cwd: '/repo',
      shell,
      config: {
        cleanup: 'always',
      },
    });
    await wt.cleanup();
    const after = calls.length;
    await wt.cleanup();
    expect(calls.length).toBe(after);
  });

  test('defaultCleanup applies when config.cleanup is unset', async () => {
    const { shell, calls } = createMockShell(happyPathProgramming());
    const wt = await createAgentWorktree({
      agentId: 'agent-d',
      cwd: '/repo',
      shell,
      config: undefined,
      defaultCleanup: 'never',
    });
    await wt.cleanup();
    expect(calls.filter((c) => c.command.includes('worktree remove'))).toHaveLength(0);
    expect(wt.worktreePath).toContain('agent-d');
  });
});

describe('post-merge hooks', () => {
  test('runPostMergeHook executes configured hooks', async () => {
    const { shell, calls } = createMockShell(happyPathProgramming());
    const wt = await createAgentWorktree({
      agentId: 'agent-pm',
      cwd: '/repo',
      shell,
      config: {
        'post-merge': 'bun install && bun run build',
      },
    });

    await wt.runPostMergeHook();

    const postMergeCalls = calls.filter((c) => c.command.includes('bun install && bun run build'));
    expect(postMergeCalls).toHaveLength(1);
    expect(postMergeCalls[0]?.cwd).toContain('agent-pm');
  });

  test('runPostMergeHook does nothing when no post-merge config', async () => {
    const { shell, calls } = createMockShell(happyPathProgramming());
    const wt = await createAgentWorktree({
      agentId: 'agent-no-pm',
      cwd: '/repo',
      shell,
      config: undefined,
    });

    const callCountBefore = calls.length;
    await wt.runPostMergeHook();
    const callCountAfter = calls.length;

    expect(callCountAfter).toBe(callCountBefore);
  });
});

describe('post-start with dependency installation', () => {
  test('post-start automatically includes bun install', async () => {
    const { shell, calls } = createMockShell(happyPathProgramming());
    await createAgentWorktree({
      agentId: 'agent-deps',
      cwd: '/repo',
      shell,
      config: {
        'post-start': 'echo "custom post-start"',
      },
    });

    // Should have both custom post-start and default bun install
    const bunInstallCalls = calls.filter((c) => c.command.includes('bun install'));
    const customCalls = calls.filter((c) => c.command.includes('echo "custom post-start"'));
    
    expect(bunInstallCalls.length).toBeGreaterThan(0);
    expect(customCalls.length).toBeGreaterThan(0);
  });
});

describe('file cloning', () => {
  function createFileCloneProgramming(): MockShellProgramming {
    return {
      rules: [
        ...happyPathProgramming().rules,
        // Mock find command to return some files
        ['find . -path', { stdout: './.env\n./config/.env.local\n', exitCode: 0 }],
        // Mock mkdir command
        ['mkdir -p', { exitCode: 0 }],
        // Mock cp command - match any cp command
        ['cp ', { exitCode: 0 }],
      ],
      default: { exitCode: 0, stdout: '', stderr: '' },
    };
  }

  test('clones configured files to worktree', async () => {
    const { shell, calls } = createMockShell(createFileCloneProgramming());
    await createAgentWorktree({
      agentId: 'agent-clone',
      cwd: '/repo',
      shell,
      config: {
        'clone-files': ['.env*', 'config/.env*'],
      },
    });

    // Should have find commands for each pattern
    const findCalls = calls.filter((c) => c.command.includes('find . -path'));
    expect(findCalls.length).toBe(2);
    expect(findCalls.some((c) => c.command.includes('.env*'))).toBe(true);
    expect(findCalls.some((c) => c.command.includes('config/.env*'))).toBe(true);

    // Should have mkdir and cp commands
    const mkdirCalls = calls.filter((c) => c.command.includes('mkdir -p'));
    const cpCalls = calls.filter((c) => c.command.includes('cp '));
    
    expect(mkdirCalls.length).toBeGreaterThan(0);
    expect(cpCalls.length).toBeGreaterThan(0);
  });

  test('skips file cloning when no files configured', async () => {
    const { shell, calls } = createMockShell(happyPathProgramming());
    await createAgentWorktree({
      agentId: 'agent-no-clone',
      cwd: '/repo',
      shell,
      config: undefined,
    });

    // Should not have any find/copy commands
    const findCalls = calls.filter((c) => c.command.includes('find . -path'));
    const cpCalls = calls.filter((c) => c.command.includes('cp '));
    
    expect(findCalls.length).toBe(0);
    expect(cpCalls.length).toBe(0);
  });

  test('handles missing files gracefully', async () => {
    const { shell, calls } = createMockShell({
      rules: [
        ...happyPathProgramming().rules,
        // Mock find command to fail (no files found)
        ['find . -path', { stdout: '', stderr: 'No files found', exitCode: 1 }],
      ],
      default: { exitCode: 0, stdout: '', stderr: '' },
    });

    // Should not throw, just log warnings
    await expect(createAgentWorktree({
      agentId: 'agent-missing-files',
      cwd: '/repo',
      shell,
      config: {
        'clone-files': ['nonexistent.env'],
      },
    })).resolves.toBeDefined();

    const findCalls = calls.filter((c) => c.command.includes('find . -path'));
    expect(findCalls.length).toBe(1);
  });
});
