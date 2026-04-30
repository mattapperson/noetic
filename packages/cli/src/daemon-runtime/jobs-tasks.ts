import { cleanupMergedWorktreesForKnownProjects } from '../commands/builtins/tasks/cleanup.js';
import { reconcileAllKnownProjects } from '../commands/builtins/tasks/daemon.js';
import type { JobDefinition } from './jobs.js';

const TASKS_RECONCILE_INTERVAL_MS = 30_000;

export function tasksReconcileJob(): JobDefinition {
  return {
    id: 'tasks.reconcile',
    intervalMs: TASKS_RECONCILE_INTERVAL_MS,
    runOnStart: true,
    run: async ({ cwd }) => {
      await reconcileAllKnownProjects(cwd);
      await cleanupMergedWorktreesForKnownProjects({
        cwd,
      });
    },
  };
}
