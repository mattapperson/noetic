import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import type { Signaller } from './agent-ci-control.js';
import { defaultSignaller } from './agent-ci-control.js';
import type { TasksDatabase } from './db/index.js';
import { openTasksDatabase } from './db/index.js';
import type * as schema from './db/schema.js';
import type { TaskRecord } from './db/schema.js';
import { AGENT_CI_REVIEW_KIND, taskSessions, tasks } from './db/schema.js';
import type { ProjectWorktree } from './git.js';
import { loadProjectWorktrees } from './git.js';
import { reconcileTasksForWorktrees } from './reconcile.js';

export type AgentCiStatus = 'unavailable' | 'running' | 'paused';

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
  agentCiStatus: AgentCiStatus;
  agentCiSessionId: string | null;
  agentCiPid: number | null;
}

export interface TaskTableData {
  projectRoot: string;
  databasePath: string;
  rows: TaskTableRow[];
}

export interface LoadTaskTableOptions {
  openDatabase?: (cwd: string) => TasksDatabase;
  signaller?: Signaller;
}

type TasksDb = BunSQLiteDatabase<typeof schema>;

interface AgentCiSessionSummary {
  sessionId: string;
  pid: number | null;
  pausedAt: string | null;
}

interface BuildRowArgs {
  record: TaskRecord;
  activeAgentCi: Map<string, AgentCiSessionSummary>;
  sessionCounts: Map<string, number>;
  currentPaths: Map<string, boolean>;
}

export async function loadTaskTableData(cwd: string): Promise<TaskTableData> {
  return loadTaskTableDataWithWorktrees(cwd, await loadProjectWorktrees(cwd));
}

export function loadTaskTableDataWithWorktrees(
  cwd: string,
  worktrees: ProjectWorktree[],
  options: LoadTaskTableOptions = {},
): TaskTableData {
  const openDatabase = options.openDatabase ?? openTasksDatabase;
  const signaller = options.signaller ?? defaultSignaller;
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
    const activeAgentCi = reconcileAndCollectAgentCiSessions(opened.db, signaller);
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
      rows: activeRecords.map((record) =>
        buildRow({
          record,
          activeAgentCi,
          sessionCounts,
          currentPaths,
        }),
      ),
    };
  } finally {
    opened.close();
  }
}

function buildRow(args: BuildRowArgs): TaskTableRow {
  const agentCi = args.activeAgentCi.get(args.record.id) ?? null;
  const agentCiStatus = deriveAgentCiStatus(agentCi);
  const exposeSession = agentCiStatus !== 'unavailable';
  return {
    id: args.record.id,
    title: args.record.title,
    projectRoot: args.record.projectRoot,
    worktreePath: args.record.worktreePath,
    branch: args.record.branch,
    headSha: args.record.headSha,
    reviewStatus: args.record.reviewStatus,
    status: args.record.status,
    sessionsCount: args.sessionCounts.get(args.record.id) ?? 0,
    current: args.currentPaths.get(args.record.worktreePath) ?? false,
    updatedAt: args.record.updatedAt,
    agentCiStatus,
    agentCiSessionId: exposeSession ? (agentCi?.sessionId ?? null) : null,
    agentCiPid: exposeSession ? (agentCi?.pid ?? null) : null,
  };
}

function deriveAgentCiStatus(session: AgentCiSessionSummary | null): AgentCiStatus {
  if (session === null) {
    return 'unavailable';
  }
  if (session.pid === null) {
    return 'unavailable';
  }
  if (session.pausedAt !== null) {
    return 'paused';
  }
  return 'running';
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

function reconcileAndCollectAgentCiSessions(
  db: TasksDb,
  signaller: Signaller,
): Map<string, AgentCiSessionSummary> {
  const rows = db
    .select({
      taskId: taskSessions.taskId,
      sessionId: taskSessions.id,
      pid: taskSessions.pid,
      pausedAt: taskSessions.pausedAt,
      startedAt: taskSessions.startedAt,
    })
    .from(taskSessions)
    .where(
      and(
        eq(taskSessions.kind, AGENT_CI_REVIEW_KIND),
        eq(taskSessions.status, 'active'),
        isNull(taskSessions.completedAt),
      ),
    )
    .orderBy(desc(taskSessions.startedAt))
    .all();
  const now = new Date().toISOString();
  const newest = new Map<string, AgentCiSessionSummary>();
  for (const row of rows) {
    if (row.pid !== null && !signaller.isAlive(row.pid)) {
      db.update(taskSessions)
        .set({
          status: 'failed',
          completedAt: now,
          pausedAt: null,
          updatedAt: now,
        })
        .where(eq(taskSessions.id, row.sessionId))
        .run();
      continue;
    }
    if (newest.has(row.taskId)) {
      continue;
    }
    newest.set(row.taskId, {
      sessionId: row.sessionId,
      pid: row.pid,
      pausedAt: row.pausedAt,
    });
  }
  return newest;
}
