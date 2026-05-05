import type { SubprocessAdapter, SubprocessHandle, SubprocessRequest } from '@noetic/core';
import { EventKind, LogEntryKind } from './schemas.js';
import type { TaskStoreAdapter } from './store-memory.js';

export type TaskExecutionRole = 'agent-ci' | 'planner' | 'implementer' | 'validator';

export interface TaskExecutionRequest {
  role: TaskExecutionRole;
  taskId: string;
  parentTaskId?: string;
  featureId?: string;
  command: string;
  args?: ReadonlyArray<string>;
  cwd?: string;
  env?: Record<string, string | undefined>;
  detached?: boolean;
  metadata?: Record<string, unknown>;
}

export interface TaskExecutionRecord {
  taskId: string;
  role: TaskExecutionRole;
  parentTaskId?: string;
  featureId?: string;
  subprocess: SubprocessHandle;
}

export interface TaskExecutionAdapter {
  start(request: TaskExecutionRequest): Promise<TaskExecutionRecord>;
  get(subprocessId: string): Promise<SubprocessHandle | null>;
  stop(subprocessId: string, reason?: string): ReturnType<SubprocessAdapter['stop']>;
  pause(subprocessId: string): ReturnType<SubprocessAdapter['pause']>;
  resume(subprocessId: string): ReturnType<SubprocessAdapter['resume']>;
  isAlive(handle: SubprocessHandle): ReturnType<SubprocessAdapter['isAlive']>;
}

export interface CreateTaskExecutionAdapterOptions {
  store: TaskStoreAdapter;
  subprocess: SubprocessAdapter;
}

function subprocessRequest(request: TaskExecutionRequest): SubprocessRequest {
  return {
    command: request.command,
    args: request.args,
    cwd: request.cwd,
    env: request.env,
    detached: request.detached,
    metadata: {
      ...(request.metadata ?? {}),
      taskRole: request.role,
      taskId: request.taskId,
      parentTaskId: request.parentTaskId,
      featureId: request.featureId,
    },
  };
}

export function createTaskExecutionAdapter(
  options: CreateTaskExecutionAdapterOptions,
): TaskExecutionAdapter {
  return {
    async start(request) {
      const subprocess = await options.subprocess.spawn(subprocessRequest(request));
      await options.store.saveRun(request.taskId, subprocess);
      await options.store.appendEvent({
        taskId: request.taskId,
        kind: EventKind.TaskUpdated,
        payload: {
          phase: 'execution-started',
          role: request.role,
          subprocessId: subprocess.id,
        },
        ts: subprocess.startedAt,
      });
      await options.store.appendLog({
        taskId: request.taskId,
        entry: {
          kind: LogEntryKind.System,
          ts: subprocess.startedAt,
          message: `${request.role} execution started (${subprocess.id})`,
          meta: {
            subprocessId: subprocess.id,
          },
        },
      });
      return {
        taskId: request.taskId,
        role: request.role,
        parentTaskId: request.parentTaskId,
        featureId: request.featureId,
        subprocess,
      };
    },
    get(subprocessId) {
      return options.subprocess.get(subprocessId);
    },
    stop(subprocessId, reason) {
      return options.subprocess.stop(subprocessId, reason);
    },
    pause(subprocessId) {
      return options.subprocess.pause(subprocessId);
    },
    resume(subprocessId) {
      return options.subprocess.resume(subprocessId);
    },
    isAlive(handle) {
      return options.subprocess.isAlive(handle);
    },
  };
}
