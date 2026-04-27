import { basename, resolve } from 'node:path';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import type { TasksDatabase } from './db/index.js';
import { openTasksDatabase } from './db/index.js';
import type * as schema from './db/schema.js';
import { tasks, taskWorktreeId } from './db/schema.js';
import type { ProjectWorktree } from './git.js';
import { loadProjectWorktrees } from './git.js';

type TasksDb = BunSQLiteDatabase<typeof schema>;

export interface ReconcileTasksResult {
  projectRoot: string;
  worktrees: ProjectWorktree[];
  activeWorktreePaths: Set<string>;
}

export async function reconcileTasksForProject(
  cwd: string,
  openDatabase: (cwd: string) => TasksDatabase = openTasksDatabase,
): Promise<ReconcileTasksResult> {
  const worktrees = await loadProjectWorktrees(cwd);
  return reconcileTasksForWorktrees(cwd, worktrees, openDatabase);
}

export function reconcileTasksForWorktrees(
  cwd: string,
  worktrees: ProjectWorktree[],
  openDatabase: (cwd: string) => TasksDatabase = openTasksDatabase,
): ReconcileTasksResult {
  const projectRoot = worktrees[0]?.projectRoot ?? resolve(cwd);
  const opened = openDatabase(cwd);
  try {
    const activeWorktreePaths = upsertWorktreeTasks(opened.db, worktrees);
    markMissingWorktreeTasksRemoved(opened.db, projectRoot, activeWorktreePaths);
    return {
      projectRoot,
      worktrees,
      activeWorktreePaths,
    };
  } finally {
    opened.close();
  }
}

export function upsertWorktreeTask(args: {
  db: TasksDb;
  projectRoot: string;
  worktreePath: string;
  branch?: string | null;
  headSha?: string | null;
  now?: string;
}): void {
  const now = args.now ?? new Date().toISOString();
  const worktreePath = resolve(args.worktreePath);
  const projectRoot = resolve(args.projectRoot);
  const branch = args.branch ?? null;
  const title = branch ?? (basename(worktreePath) || worktreePath);
  args.db
    .insert(tasks)
    .values({
      id: taskWorktreeId(projectRoot, worktreePath),
      projectRoot,
      worktreePath,
      title,
      branch,
      headSha: args.headSha ?? null,
      reviewStatus: 'not_started',
      status: 'active',
      source: 'git-worktree',
      cleanupReason: null,
      cleanupAt: null,
      provider: null,
      providerId: null,
      providerUrl: null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: tasks.worktreePath,
      set: {
        projectRoot,
        title,
        branch,
        headSha: args.headSha ?? null,
        status: sql`case when ${tasks.status} = 'removed' then 'active' else ${tasks.status} end`,
        updatedAt: now,
        lastSeenAt: now,
      },
    })
    .run();
}

function upsertWorktreeTasks(db: TasksDb, worktrees: ProjectWorktree[]): Set<string> {
  const now = new Date().toISOString();
  const activeWorktreePaths = new Set<string>();
  for (const worktree of worktrees) {
    const worktreePath = resolve(worktree.path);
    activeWorktreePaths.add(worktreePath);
    upsertWorktreeTask({
      db,
      projectRoot: worktree.projectRoot,
      worktreePath,
      branch: worktree.branch,
      headSha: worktree.headSha,
      now,
    });
  }
  return activeWorktreePaths;
}

function markMissingWorktreeTasksRemoved(
  db: TasksDb,
  projectRoot: string,
  activeWorktreePaths: Set<string>,
): void {
  const now = new Date().toISOString();
  const baseConditions = [
    eq(tasks.projectRoot, resolve(projectRoot)),
    eq(tasks.source, 'git-worktree'),
    inArray(tasks.status, [
      'active',
      'cleanup-blocked',
    ]),
  ];
  const where =
    activeWorktreePaths.size > 0
      ? and(...baseConditions, notInArray(tasks.worktreePath, Array.from(activeWorktreePaths)))
      : and(...baseConditions);
  db.update(tasks)
    .set({
      status: 'removed',
      cleanupReason: 'worktree not found by git worktree list',
      cleanupAt: now,
      updatedAt: now,
    })
    .where(where)
    .run();
}
