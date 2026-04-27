import { eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { TasksDatabase } from './db/index.js';
import { openTasksDatabase } from './db/index.js';
import type * as schema from './db/schema.js';
import type { TaskRecord } from './db/schema.js';
import { taskSessions, tasks } from './db/schema.js';
import type { ProjectWorktree } from './git.js';
import { loadProjectWorktrees } from './git.js';
import { reconcileTasksForWorktrees } from './reconcile.js';

export interface TaskTableRow {
  id: string;
  title: string;
  projectRoot: string;
  worktreePath: string;
  branch: string | null;
  headSha: string | null;
  reviewStatus: TaskRecord['reviewStatus'];
  sessionsCount: number;
  current: boolean;
  status: TaskRecord['status'];
  updatedAt: string;
}

export interface TaskTableData {
  projectRoot: string;
  databasePath: string;
  rows: TaskTableRow[];
}

type TasksDb = BunSQLiteDatabase<typeof schema>;

export async function loadTaskTableData(cwd: string): Promise<TaskTableData> {
  return loadTaskTableDataWithWorktrees(cwd, await loadProjectWorktrees(cwd));
}

export function loadTaskTableDataWithWorktrees(
  cwd: string,
  worktrees: ProjectWorktree[],
  openDatabase: (cwd: string) => TasksDatabase = openTasksDatabase,
): TaskTableData {
  const reconciled = reconcileTasksForWorktrees(cwd, worktrees, openDatabase);
  const projectRoot = reconciled.projectRoot;
  const opened = openDatabase(cwd);
  try {
    if (worktrees.length === 0) {
      return {
        projectRoot,
        databasePath: opened.path,
        rows: [],
      };
    }

    const currentPaths = new Map(
      worktrees.map((worktree) => [
        worktree.path,
        worktree.current,
      ]),
    );
    const sessionCounts = getSessionCounts(opened.db);
    const records = opened.db
      .select()
      .from(tasks)
      .where(eq(tasks.projectRoot, projectRoot))
      .orderBy(tasks.worktreePath)
      .all();
    const activeRecords = records.filter(
      (record) => record.status === 'active' && currentPaths.has(record.worktreePath),
    );

    return {
      projectRoot,
      databasePath: opened.path,
      rows: activeRecords.map((record) => ({
        id: record.id,
        title: record.title,
        projectRoot: record.projectRoot,
        worktreePath: record.worktreePath,
        branch: record.branch,
        headSha: record.headSha,
        reviewStatus: record.reviewStatus,
        status: record.status,
        sessionsCount: sessionCounts.get(record.id) ?? 0,
        current: currentPaths.get(record.worktreePath) ?? false,
        updatedAt: record.updatedAt,
      })),
    };
  } finally {
    opened.close();
  }
}

function getSessionCounts(db: TasksDb): Map<string, number> {
  const rows = db
    .select({
      taskId: taskSessions.taskId,
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(taskSessions)
    .groupBy(taskSessions.taskId)
    .all();
  return new Map(
    rows.map((row) => [
      row.taskId,
      row.count,
    ]),
  );
}
