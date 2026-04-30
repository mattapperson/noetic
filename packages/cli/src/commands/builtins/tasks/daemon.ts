import { resolve } from 'node:path';

import { ensureDaemon } from '../../../daemon-runtime/runtime.js';
import { openTasksDatabase } from './db/index.js';
import { tasks } from './db/schema.js';
import { reconcileTasksForProject } from './reconcile.js';

export async function reconcileAllKnownProjects(currentCwd: string): Promise<void> {
  const roots = knownProjectRoots(currentCwd);
  roots.add(resolve(currentCwd));
  for (const root of roots) {
    await reconcileTasksForProject(root).catch(() => undefined);
  }
}

export function ensureTasksDaemon(cwd: string): void {
  ensureDaemon(cwd);
}

function knownProjectRoots(cwd: string): Set<string> {
  const opened = openTasksDatabase(cwd);
  try {
    const rows = opened.db
      .select({
        projectRoot: tasks.projectRoot,
      })
      .from(tasks)
      .all();
    return new Set(rows.map((row) => resolve(row.projectRoot)));
  } finally {
    opened.close();
  }
}
