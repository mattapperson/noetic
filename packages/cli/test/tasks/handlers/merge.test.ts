import { describe, expect, it } from 'bun:test';
import { EventKind, TaskLifecycleStatus } from '@noetic/code-agent/tasks/schema';

import { loadTask, saveTask, tailEvents } from '@noetic/code-agent/tasks/store/fs-node';
import type { ShellAdapter, ShellExecResult } from '@noetic-tools/core';
import { createTaskHandler } from '../../../src/tasks/runtime/handlers/lifecycle.js';
import { mergeTaskHandler } from '../../../src/tasks/runtime/handlers/state.js';
import { makeStoreContext } from '../_helpers.js';

interface RecordedExec {
  readonly command: string;
}

function makeShell(handler: (command: string) => ShellExecResult): {
  shell: ShellAdapter;
  calls: RecordedExec[];
} {
  const calls: RecordedExec[] = [];
  return {
    shell: {
      async exec(command) {
        calls.push({
          command,
        });
        return handler(command);
      },
    },
    calls,
  };
}

describe('mergeTaskHandler', () => {
  it('merges via wt and flips lifecycle to merged', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Merge me',
    });
    await saveTask(ctx, {
      ...created.task,
      branch: 'feature/foo',
    });

    const { shell, calls } = makeShell(() => ({
      stdout: 'Merged feature/foo into main\n',
      stderr: '',
      exitCode: 0,
    }));
    const result = await mergeTaskHandler(ctx, {
      taskId: created.task.id,
      shell,
    });
    expect(result.tool).toBe('wt');
    expect(calls.length).toBe(1);
    expect(calls[0]?.command).toBe('wt merge feature/foo');

    const reloaded = await loadTask(ctx, created.task.id);
    expect(reloaded.lifecycleStatus).toBe(TaskLifecycleStatus.Merged);

    const events = await tailEvents(ctx);
    const reviewEvents = events.filter((e) => e.kind === EventKind.TaskReviewStatusChanged);
    expect(reviewEvents.length).toBe(1);
    expect(reviewEvents[0]?.payload?.mergedVia).toBe('wt');
  });

  it('falls back to git when shell.exec throws ENOENT for wt', async () => {
    // Some platforms surface "binary not on PATH" as a thrown ENOENT
    // rather than a synthetic exit 127. execTolerantOfMissing is
    // responsible for normalising both signals; this test pins the
    // ENOENT-throw branch for the merge caller.
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'ENOENT fallback',
    });
    await saveTask(ctx, {
      ...created.task,
      branch: 'feature/enoent',
    });
    const calls: RecordedExec[] = [];
    const shell: ShellAdapter = {
      async exec(command) {
        calls.push({
          command,
        });
        if (command.startsWith('wt')) {
          const err: NodeJS.ErrnoException = new Error('spawn wt ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        return {
          stdout: 'Merge made by the recursive strategy.',
          stderr: '',
          exitCode: 0,
        };
      },
    };
    const result = await mergeTaskHandler(ctx, {
      taskId: created.task.id,
      shell,
    });
    expect(result.tool).toBe('git');
    expect(calls.map((c) => c.command)).toEqual([
      'wt merge feature/enoent',
      'git merge --no-edit feature/enoent',
    ]);
  });

  it('falls back to git when wt is not installed (exit 127)', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Fall back',
    });
    await saveTask(ctx, {
      ...created.task,
      branch: 'feature/bar',
    });

    const { shell, calls } = makeShell((command) => {
      if (command.startsWith('wt')) {
        return {
          stdout: '',
          stderr: 'sh: wt: command not found',
          exitCode: 127,
        };
      }
      return {
        stdout: 'Merge made by the recursive strategy.',
        stderr: '',
        exitCode: 0,
      };
    });
    const result = await mergeTaskHandler(ctx, {
      taskId: created.task.id,
      shell,
    });
    expect(result.tool).toBe('git');
    expect(calls.length).toBe(2);
    expect(calls[1]?.command).toBe('git merge --no-edit feature/bar');
  });

  it('throws when no branch is recorded', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'No branch',
    });
    await expect(
      mergeTaskHandler(ctx, {
        taskId: created.task.id,
      }),
    ).rejects.toThrow(/no branch/);
  });

  it('throws when both wt and git fail', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Both fail',
    });
    await saveTask(ctx, {
      ...created.task,
      branch: 'feature/baz',
    });
    const { shell } = makeShell((command) => {
      if (command.startsWith('wt')) {
        return {
          stdout: '',
          stderr: 'sh: wt: command not found',
          exitCode: 127,
        };
      }
      return {
        stdout: '',
        stderr: 'CONFLICT (content)',
        exitCode: 1,
      };
    });
    await expect(
      mergeTaskHandler(ctx, {
        taskId: created.task.id,
        shell,
      }),
    ).rejects.toThrow(/Merge via git failed/);
  });
});
