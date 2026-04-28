import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TasksDatabase } from '../src/commands/builtins/tasks/db/index.js';
import { openTasksDatabaseAtPath } from '../src/commands/builtins/tasks/db/index.js';
import { taskSessions, tasks } from '../src/commands/builtins/tasks/db/schema.js';

export function freshTasksDb(prefix: string): TasksDatabase {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return openTasksDatabaseAtPath(join(dir, 'tasks.sqlite'));
}

export interface SeedTaskArgs {
  opened: TasksDatabase;
  taskId: string;
  projectRoot?: string;
  worktreePath?: string;
  branch?: string;
  title?: string;
}

export function seedTask(args: SeedTaskArgs): void {
  const now = new Date().toISOString();
  const branch = args.branch ?? args.taskId;
  args.opened.db
    .insert(tasks)
    .values({
      id: args.taskId,
      projectRoot: args.projectRoot ?? '/repo',
      worktreePath: args.worktreePath ?? `/repo-${args.taskId}`,
      title: args.title ?? args.taskId,
      branch,
      headSha: null,
      reviewStatus: 'not_started',
      status: 'active',
      source: 'git-worktree',
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    })
    .run();
}

export interface SeedAgentCiSessionArgs {
  opened: TasksDatabase;
  taskId: string;
  sessionId: string;
  pid: number | null;
  pausedAt?: string | null;
  status?: 'active' | 'completed' | 'cancelled' | 'failed';
  startedAt?: string;
  completedAt?: string | null;
}

export function seedAgentCiSession(args: SeedAgentCiSessionArgs): void {
  const now = args.startedAt ?? new Date().toISOString();
  args.opened.db
    .insert(taskSessions)
    .values({
      id: args.sessionId,
      taskId: args.taskId,
      sessionId: args.sessionId,
      kind: 'agent_ci_review',
      status: args.status ?? 'active',
      title: 'agent-ci review',
      startedAt: now,
      completedAt: args.completedAt ?? null,
      createdAt: now,
      updatedAt: now,
      pid: args.pid,
      pausedAt: args.pausedAt ?? null,
    })
    .run();
}
