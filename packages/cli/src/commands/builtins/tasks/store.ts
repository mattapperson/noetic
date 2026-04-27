import { basename } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { TasksDatabase } from './db/index.js';
import { openTasksDatabase } from './db/index.js';
import type * as schema from './db/schema.js';
import type { TaskRecord } from './db/schema.js';
import { taskSessions, tasks, taskWorktreeId } from './db/schema.js';
import type { ProjectWorktree } from './git.js';
import { loadProjectWorktrees } from './git.js';

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
  const projectRoot = worktrees[0]?.projectRoot ?? cwd;
  const opened = openDatabase(cwd);
  try {
    if (worktrees.length === 0) {
      return {
        projectRoot,
        databasePath: opened.path,
        rows: [],
      };
    }

    upsertWorktreeTasks(opened.db, worktrees);
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
    const activeRecords = records.filter((record) => currentPaths.has(record.worktreePath));

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
        sessionsCount: sessionCounts.get(record.id) ?? 0,
        current: currentPaths.get(record.worktreePath) ?? false,
        updatedAt: record.updatedAt,
      })),
    };
  } finally {
    opened.close();
  }
}

function upsertWorktreeTasks(db: TasksDb, worktrees: ProjectWorktree[]): void {
  const now = new Date().toISOString();
  for (const worktree of worktrees) {
    const id = taskWorktreeId(worktree.projectRoot, worktree.path);
    db.insert(tasks)
      .values({
        id,
        projectRoot: worktree.projectRoot,
        worktreePath: worktree.path,
        title: taskTitle(worktree),
        branch: worktree.branch,
        headSha: worktree.headSha,
        reviewStatus: 'not_started',
        source: 'git-worktree',
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: tasks.worktreePath,
        set: {
          title: taskTitle(worktree),
          branch: worktree.branch,
          headSha: worktree.headSha,
          updatedAt: now,
          lastSeenAt: now,
        },
      })
      .run();
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

function taskTitle(worktree: ProjectWorktree): string {
  return worktree.branch ?? (basename(worktree.path) || worktree.path);
}
