import { createLocalFsAdapter } from '@noetic/core';

import { loadProjectWorktrees } from '../commands/builtins/tasks/git.js';
import { reconcileTasksFs } from '../commands/builtins/tasks/reconcile-fs.js';
import type { JobDefinition } from './jobs.js';

const TASKS_RECONCILE_INTERVAL_MS = 30_000;

export function tasksReconcileJob(): JobDefinition {
  return {
    id: 'tasks.reconcile',
    intervalMs: TASKS_RECONCILE_INTERVAL_MS,
    runOnStart: true,
    run: async ({ cwd }) => {
      const fs = createLocalFsAdapter();
      const worktrees = await loadProjectWorktrees(cwd).catch(() => []);
      await reconcileTasksFs(
        {
          fs,
          projectRoot: cwd,
        },
        worktrees,
      ).catch(() => undefined);
    },
  };
}
