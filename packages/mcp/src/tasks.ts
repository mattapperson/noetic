/**
 * Long-running operations over the Tasks extension (SEP-2663): status by
 * `tasks/get` (woken early by `notifications/tasks/status`), answers to
 * `input_required` by `tasks/update`, cancellation by `tasks/cancel`.
 */

import type {
  ArtifactStore,
  CallOutcome,
  ConnectionInputRequest,
  ConnectionTaskStatus,
  ConnectionTasks,
} from '@noetic-tools/types';
import { ConnectionErrorPayloadSchema } from '@noetic-tools/types';
import { toolResultOutput } from './content';
import { connectionError, toolErrorPayload } from './errors';
import type { McpSession } from './session';
import { pause, Waker } from './timing';
import type { WireTaskStatus } from './wire';
import { EmptyResultSchema, McpMethod, McpNotification, TaskStatusSchema } from './wire';

//#region Types

/** @public What the task client needs from its connection. */
export interface TaskContext {
  readonly session: McpSession;
  readonly artifacts: ArtifactStore;
  /** `_meta` sent with every task request (the instance, when one server serves several). */
  readonly meta: Readonly<Record<string, unknown>>;
  readonly pollIntervalMs: number;
}

//#endregion

//#region Helpers

function inputRequest(status: WireTaskStatus): ConnectionInputRequest | undefined {
  const [entry] = Object.entries(status.inputRequests ?? {});
  if (entry === undefined) {
    return undefined;
  }
  const [id, request] = entry;
  return {
    id,
    message: request.message,
    ...(request.requestedSchema === undefined
      ? {}
      : {
          schema: request.requestedSchema,
        }),
  };
}

/** @public A wire task status as a `ConnectionTaskStatus`. */
export function toTaskStatus(status: WireTaskStatus): ConnectionTaskStatus {
  const request = status.status === 'input_required' ? inputRequest(status) : undefined;
  return {
    taskId: status.taskId,
    state: status.status,
    ...(status.statusMessage === undefined
      ? {}
      : {
          message: status.statusMessage,
        }),
    ...(status.progress === undefined
      ? {}
      : {
          progress: status.progress,
        }),
    ...(request === undefined
      ? {}
      : {
          request,
        }),
  };
}

async function outcomeOf(status: WireTaskStatus, artifacts: ArtifactStore): Promise<CallOutcome> {
  if (status.status === 'completed') {
    if (status.result?.isError === true) {
      return {
        status: 'error',
        error: toolErrorPayload(status.result),
      };
    }
    return {
      status: 'ok',
      output: status.result === undefined ? null : await toolResultOutput(status.result, artifacts),
    };
  }
  if (status.status === 'failed') {
    const parsed = ConnectionErrorPayloadSchema.safeParse(status.error);
    return {
      status: 'error',
      error: parsed.success
        ? parsed.data
        : connectionError(
            'unavailable',
            status.error?.message ?? status.statusMessage ?? 'The task failed.',
          ),
    };
  }
  return {
    status: 'error',
    error: connectionError('unavailable', status.statusMessage ?? 'The task was cancelled.'),
  };
}

function isTerminal(status: WireTaskStatus): boolean {
  return (
    status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled'
  );
}

function progressKey(status: ConnectionTaskStatus): string {
  return JSON.stringify(status);
}

//#endregion

//#region Public API

/** @public `ConnectionTasks` over one MCP session. */
export function createTasks(ctx: TaskContext): ConnectionTasks {
  const fetchStatus = async (taskId: string, signal: AbortSignal): Promise<WireTaskStatus> =>
    ctx.session.request(
      McpMethod.TasksGet,
      {
        taskId,
        _meta: ctx.meta,
      },
      TaskStatusSchema,
      {
        signal,
      },
    );

  return {
    async get(taskId, opts): Promise<ConnectionTaskStatus> {
      return toTaskStatus(await fetchStatus(taskId, opts.signal));
    },
    async result(taskId, opts): Promise<CallOutcome> {
      const waker = new Waker();
      const off = ctx.session.on(McpNotification.TaskStatus, (params) => {
        if (params.taskId === taskId) {
          waker.fire();
        }
      });
      try {
        let last = '';
        for (;;) {
          const status = await fetchStatus(taskId, opts.signal);
          const reported = toTaskStatus(status);
          const key = progressKey(reported);
          if (key !== last) {
            last = key;
            opts.onProgress?.(reported);
          }
          if (isTerminal(status)) {
            return outcomeOf(status, ctx.artifacts);
          }
          await pause(status.pollInterval ?? ctx.pollIntervalMs, opts.signal, waker.next);
        }
      } finally {
        off();
      }
    },
    async cancel(taskId): Promise<void> {
      await ctx.session.request(
        McpMethod.TasksCancel,
        {
          taskId,
          _meta: ctx.meta,
        },
        EmptyResultSchema,
      );
    },
    async respond(taskId, requestId, answer): Promise<void> {
      await ctx.session.request(
        McpMethod.TasksUpdate,
        {
          taskId,
          inputResponses: {
            [requestId]: answer,
          },
          _meta: ctx.meta,
        },
        EmptyResultSchema,
      );
    },
  };
}

//#endregion
