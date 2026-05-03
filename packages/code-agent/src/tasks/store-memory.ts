import type { SubprocessHandle } from '@noetic/core';
import type { Event, LogEntry, Task } from './schemas.js';
import {
  AutopilotState,
  EventKind,
  generateTaskId,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSchema,
  TaskSource,
} from './schemas.js';

export interface CreateTaskInput {
  title: string;
  projectRoot: string;
  source?: Task['source'];
  worktreePath?: string | null;
  branch?: string | null;
  headSha?: string | null;
  now?: string;
}

export interface UpdateTaskInput {
  taskId: string;
  patch: Partial<Omit<Task, 'id' | 'createdAt'>>;
  now?: string;
}

export interface AppendTaskEventInput {
  taskId: string | null;
  kind: EventKind;
  payload?: Record<string, unknown>;
  ts?: string;
}

export interface AppendTaskLogInput {
  taskId: string;
  entry: Omit<LogEntry, 'chunk' | 'chunkCount'>;
}

export interface TaskStoreAdapter {
  createTask(input: CreateTaskInput): Promise<Task>;
  saveTask(task: Task): Promise<void>;
  getTask(taskId: string): Promise<Task | null>;
  listTasks(): Promise<ReadonlyArray<Task>>;
  updateTask(input: UpdateTaskInput): Promise<Task>;
  deleteTask(taskId: string): Promise<void>;
  appendEvent(input: AppendTaskEventInput): Promise<Event>;
  tailEvents(sinceId?: number): Promise<ReadonlyArray<Event>>;
  appendLog(input: AppendTaskLogInput): Promise<void>;
  readLog(taskId: string): Promise<ReadonlyArray<LogEntry>>;
  saveRun(taskId: string, handle: SubprocessHandle): Promise<void>;
  getRun(handleId: string): Promise<SubprocessHandle | null>;
  listRuns(taskId?: string): Promise<ReadonlyArray<SubprocessHandle>>;
  deleteRun(handleId: string): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildTask(input: CreateTaskInput): Task {
  const now = input.now ?? nowIso();
  return TaskSchema.parse({
    id: generateTaskId(),
    source: input.source ?? TaskSource.Manual,
    title: input.title,
    projectRoot: input.projectRoot,
    worktreePath: input.worktreePath ?? null,
    branch: input.branch ?? null,
    headSha: input.headSha ?? null,
    reviewStatus: TaskReviewStatus.NotStarted,
    lifecycleStatus: TaskLifecycleStatus.Active,
    paused: false,
    pauseReason: null,
    archivedAt: null,
    hierarchyStatus: null,
    autopilotEnabled: false,
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
}

export function createMemoryTaskStore(): TaskStoreAdapter {
  const tasks = new Map<string, Task>();
  const events: Event[] = [];
  const logs = new Map<string, LogEntry[]>();
  const runs = new Map<
    string,
    SubprocessHandle & {
      taskId?: string;
    }
  >();
  let lastEventId = 0;

  return {
    async createTask(input) {
      const task = buildTask(input);
      tasks.set(task.id, task);
      await this.appendEvent({
        taskId: task.id,
        kind: EventKind.TaskCreated,
        payload: {
          title: task.title,
        },
        ts: task.createdAt,
      });
      return task;
    },
    async saveTask(task) {
      tasks.set(task.id, TaskSchema.parse(task));
    },
    async getTask(taskId) {
      return tasks.get(taskId) ?? null;
    },
    async listTasks() {
      return [
        ...tasks.values(),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async updateTask(input) {
      const existing = tasks.get(input.taskId);
      if (!existing) {
        throw new Error(`Unknown task: ${input.taskId}`);
      }
      const now = input.now ?? nowIso();
      const next = TaskSchema.parse({
        ...existing,
        ...input.patch,
        updatedAt: now,
        lastSeenAt: input.patch.lastSeenAt ?? now,
      });
      tasks.set(next.id, next);
      await this.appendEvent({
        taskId: next.id,
        kind: EventKind.TaskUpdated,
        payload: {
          patch: input.patch,
        },
        ts: now,
      });
      return next;
    },
    async deleteTask(taskId) {
      tasks.delete(taskId);
      logs.delete(taskId);
      for (const [runId, run] of runs) {
        if (run.taskId === taskId) {
          runs.delete(runId);
        }
      }
      await this.appendEvent({
        taskId,
        kind: EventKind.TaskDeleted,
      });
    },
    async appendEvent(input) {
      const event: Event = {
        id: ++lastEventId,
        taskId: input.taskId,
        kind: input.kind,
        payload: input.payload,
        ts: input.ts ?? nowIso(),
      };
      events.push(event);
      return event;
    },
    async tailEvents(sinceId = 0) {
      return events.filter((event) => event.id > sinceId);
    },
    async appendLog(input) {
      const taskLogs = logs.get(input.taskId) ?? [];
      taskLogs.push({
        ...input.entry,
        chunk: 1,
        chunkCount: 1,
      });
      logs.set(input.taskId, taskLogs);
      await this.appendEvent({
        taskId: input.taskId,
        kind: EventKind.LogAppended,
        payload: {
          kind: input.entry.kind,
        },
        ts: input.entry.ts,
      });
    },
    async readLog(taskId) {
      return [
        ...(logs.get(taskId) ?? []),
      ];
    },
    async saveRun(taskId, handle) {
      runs.set(handle.id, {
        ...handle,
        taskId,
      });
    },
    async getRun(handleId) {
      const run = runs.get(handleId);
      if (!run) {
        return null;
      }
      const { taskId: _taskId, ...handle } = run;
      return handle;
    },
    async listRuns(taskId) {
      const all = [
        ...runs.values(),
      ];
      const filtered = taskId ? all.filter((run) => run.taskId === taskId) : all;
      return filtered.map(({ taskId: _taskId, ...handle }) => handle);
    },
    async deleteRun(handleId) {
      runs.delete(handleId);
    },
  };
}
