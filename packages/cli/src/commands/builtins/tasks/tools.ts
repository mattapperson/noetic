/**
 * Agent-facing wrappers around the `tasks/handlers/` verb handlers.
 *
 * Every Phase-7 handler is exposed here as a snake_case `task_*` tool so the
 * model can drive the kanban from inside a chat turn. The factory keeps the
 * mapping declarative — each entry pairs a Zod input schema (mirroring the
 * handler's `args`) with a thin executor that validates and forwards.
 *
 * Read-only mode trims the surface to the three observation tools
 * (`task_show`, `task_list`, `task_logs`); mutators are simply omitted from
 * the returned array rather than gated at runtime, so a misbehaving model
 * cannot stumble into them via permission errors.
 */

import type { Tool } from '@noetic/core';
import { tool } from '@noetic/core';
import { z } from 'zod';

import type { TaskStoreContext } from './fs-store.js';
import { activateSliceHandler } from './handlers/activate-slice.js';
import { addAssertionHandler } from './handlers/add-assertion.js';
import { addFeatureHandler } from './handlers/add-feature.js';
import { addMilestoneHandler } from './handlers/add-milestone.js';
import { addSliceHandler } from './handlers/add-slice.js';
import { archiveTaskHandler } from './handlers/archive.js';
import { attachTaskHandler } from './handlers/attach.js';
import { autopilotHandler } from './handlers/autopilot.js';
import { commentTaskHandler } from './handlers/comment.js';
import { createTaskHandler } from './handlers/create.js';
import { deleteTaskHandler } from './handlers/delete.js';
import { duplicateTaskHandler } from './handlers/duplicate.js';
import { listTasksHandler } from './handlers/list.js';
import { logTaskHandler } from './handlers/log.js';
import { logsTaskHandler } from './handlers/logs.js';
import { mergeTaskHandler } from './handlers/merge.js';
import { moveTaskHandler } from './handlers/move.js';
import { pauseTaskHandler } from './handlers/pause.js';
import { planTaskHandler } from './handlers/plan.js';
import { showTaskHandler } from './handlers/show.js';
import { steerTaskHandler } from './handlers/steer.js';
import { unarchiveTaskHandler } from './handlers/unarchive.js';
import { unpauseTaskHandler } from './handlers/unpause.js';
import type { TaskHierarchyInput } from './hierarchy/schemas.js';
import { FeatureIdSchema, MilestoneIdSchema, SliceIdSchema } from './hierarchy/schemas.js';
import { KanbanColumn } from './kanban.js';
import { TaskIdSchema, TaskSource } from './schemas.js';

//#region Types

export interface TaskToolsOptions {
  readonly ctx: TaskStoreContext;
  /** When `true`, only the read-only observation tools are returned. */
  readonly readOnly?: boolean;
}

//#endregion

//#region Shared schemas

const TaskRefSchema = TaskIdSchema.describe('Task id of the form T-<10 chars>.');
const KanbanColumnSchema = z
  .enum([
    KanbanColumn.Triage,
    KanbanColumn.InProgress,
    KanbanColumn.NeedsChanges,
    KanbanColumn.ReadyToMerge,
    KanbanColumn.Done,
    KanbanColumn.CleanupBlocked,
    KanbanColumn.Removed,
    KanbanColumn.Archived,
  ])
  .describe('Logical kanban column for a task.');
const TaskSourceSchema = z
  .enum([
    TaskSource.Manual,
    TaskSource.Worktree,
  ])
  .describe('How the task entered the store.');

const FeatureInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  acceptanceCriteria: z.string(),
});

const AssertionInputSchema = z.object({
  title: z.string().min(1),
  assertion: z.string(),
  featureIndices: z.array(z.number().int().min(0)),
});

const SliceInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  verification: z.string(),
  features: z.array(FeatureInputSchema),
});

const MilestoneInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  verification: z.string(),
  slices: z.array(SliceInputSchema),
  assertions: z.array(AssertionInputSchema),
});

const TaskHierarchyInputSchema = z.object({
  milestones: z.array(MilestoneInputSchema),
});

const ResultEnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

type ResultEnvelope = z.infer<typeof ResultEnvelopeSchema>;

//#endregion

//#region Helpers

function ok(data: unknown): ResultEnvelope {
  return {
    ok: true,
    data,
  };
}

function fail(err: unknown): ResultEnvelope {
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Wrap a handler invocation so it always resolves to a `ResultEnvelope`,
 * never throws. Tool callers (LLMs) see structured success/failure rather
 * than synchronous exceptions that the harness would otherwise surface as
 * tool-call errors.
 */
async function safeRun(fn: () => Promise<unknown>): Promise<ResultEnvelope> {
  try {
    const data = await fn();
    return ok(data);
  } catch (err) {
    return fail(err);
  }
}

/**
 * Stable shape for `nullable().optional()` description fields: when the model
 * omits the value or sends `null`, the handlers expect `undefined`/`null`
 * symmetrically — the conversion happens here.
 */
function normaliseDescription(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return value;
}

//#endregion

//#region Read-only tool factories

function makeShowTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_show',
    description:
      'Read a single task: returns the canonical record, recent log entries, and any planned hierarchy.',
    input: z.object({
      taskId: TaskRefSchema,
      logTail: z.number().int().min(0).max(1e3).optional(),
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        showTaskHandler(ctx, {
          taskId: args.taskId,
          logTail: args.logTail,
        }),
      ),
  });
}

function makeListTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_list',
    description:
      'Enumerate tasks, optionally filtered by kanban column, source, or archived flag (default omits archived).',
    input: z.object({
      column: KanbanColumnSchema.optional(),
      source: TaskSourceSchema.optional(),
      all: z.boolean().optional(),
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        listTasksHandler(ctx, {
          column: args.column,
          source: args.source,
          all: args.all,
        }),
      ),
  });
}

function makeLogsTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_logs',
    description: 'Tail the most recent log entries for a task (default 50).',
    input: z.object({
      taskId: TaskRefSchema,
      n: z.number().int().min(1).max(1e3).optional(),
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        logsTaskHandler(ctx, {
          taskId: args.taskId,
          n: args.n,
        }),
      ),
  });
}

//#endregion

//#region Mutator tool factories

function makeCreateTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_create',
    description: 'Create a fresh manual task with a title and optional description.',
    input: z.object({
      title: z.string().min(1),
      description: z.string().optional(),
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        createTaskHandler(ctx, {
          title: args.title,
          description: args.description,
        }),
      ),
  });
}

function makeMoveTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_move',
    description: 'Move a task to a different kanban column.',
    input: z.object({
      taskId: TaskRefSchema,
      column: KanbanColumnSchema,
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        moveTaskHandler(ctx, {
          taskId: args.taskId,
          column: args.column,
        }),
      ),
  });
}

function makeLogTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_log',
    description: "Append a freeform log entry to a task's audit trail.",
    input: z.object({
      taskId: TaskRefSchema,
      message: z.string().min(1),
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        logTaskHandler(ctx, {
          taskId: args.taskId,
          message: args.message,
        }),
      ),
  });
}

function makeAttachTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_attach',
    description: "Attach a file (by absolute path) to a task's attachments folder.",
    input: z.object({
      taskId: TaskRefSchema,
      sourcePath: z.string().min(1),
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        attachTaskHandler(ctx, {
          taskId: args.taskId,
          sourcePath: args.sourcePath,
        }),
      ),
  });
}

function makeCommentTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_comment',
    description: 'Append a human-style comment-kind log entry to a task.',
    input: z.object({
      taskId: TaskRefSchema,
      message: z.string().min(1),
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        commentTaskHandler(ctx, {
          taskId: args.taskId,
          message: args.message,
        }),
      ),
  });
}

function makeSteerTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_steer',
    description:
      "Append a steering directive: log entry plus a stanza in the task's steering.md file.",
    input: z.object({
      taskId: TaskRefSchema,
      message: z.string().min(1),
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        steerTaskHandler(ctx, {
          taskId: args.taskId,
          message: args.message,
        }),
      ),
  });
}

function makePauseTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_pause',
    description: 'Pause the active agent-ci runner for a task.',
    input: z.object({
      taskId: TaskRefSchema,
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        pauseTaskHandler(ctx, {
          taskId: args.taskId,
        }),
      ),
  });
}

function makeUnpauseTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_unpause',
    description: 'Resume a paused agent-ci runner for a task.',
    input: z.object({
      taskId: TaskRefSchema,
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        unpauseTaskHandler(ctx, {
          taskId: args.taskId,
        }),
      ),
  });
}

function makeArchiveTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_archive',
    description: 'Mark a task archived. Idempotent — already-archived tasks keep their timestamp.',
    input: z.object({
      taskId: TaskRefSchema,
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        archiveTaskHandler(ctx, {
          taskId: args.taskId,
        }),
      ),
  });
}

function makeUnarchiveTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_unarchive',
    description: 'Clear archivedAt, returning a task to its prior column.',
    input: z.object({
      taskId: TaskRefSchema,
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        unarchiveTaskHandler(ctx, {
          taskId: args.taskId,
        }),
      ),
  });
}

function makeDeleteTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_delete',
    description: 'Hard-delete a task and remove its on-disk directory. Use with care.',
    input: z.object({
      taskId: TaskRefSchema,
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        deleteTaskHandler(ctx, {
          taskId: args.taskId,
        }),
      ),
  });
}

function makeDuplicateTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_duplicate',
    description: 'Duplicate a task (description + attachments only); resets review and autopilot.',
    input: z.object({
      taskId: TaskRefSchema,
      title: z.string().min(1).optional(),
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        duplicateTaskHandler(ctx, {
          taskId: args.taskId,
          title: args.title,
        }),
      ),
  });
}

function makeMergeTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_merge',
    description:
      "Merge a task's branch via wt (worktrunk); falls back to git merge if wt is unavailable.",
    input: z.object({
      taskId: TaskRefSchema,
      branch: z.string().min(1).optional(),
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        mergeTaskHandler(ctx, {
          taskId: args.taskId,
          branch: args.branch,
        }),
      ),
  });
}

function makePlanTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_plan',
    description:
      'Persist a pre-built task hierarchy (milestones/slices/features/assertions). Bypasses the live interview — pass the structured envelope directly.',
    input: z.object({
      taskId: TaskRefSchema,
      hierarchy: TaskHierarchyInputSchema,
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() => {
        const envelope: TaskHierarchyInput = args.hierarchy;
        return planTaskHandler(ctx, {
          taskId: args.taskId,
          runInterview: () =>
            Promise.resolve({
              status: 'complete',
              envelope,
            }),
        });
      }),
  });
}

function makeAddMilestoneTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_add_milestone',
    description: "Append a milestone to a task's hierarchy.",
    input: z.object({
      taskId: TaskRefSchema,
      title: z.string().min(1),
      verification: z.string(),
      description: z.string().optional(),
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        addMilestoneHandler(ctx, {
          taskId: args.taskId,
          title: args.title,
          verification: args.verification,
          description: normaliseDescription(args.description),
        }),
      ),
  });
}

function makeAddSliceTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_add_slice',
    description: 'Append a slice under an existing milestone.',
    input: z.object({
      taskId: TaskRefSchema,
      milestoneId: MilestoneIdSchema,
      title: z.string().min(1),
      verification: z.string(),
      description: z.string().optional(),
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        addSliceHandler(ctx, {
          taskId: args.taskId,
          milestoneId: args.milestoneId,
          title: args.title,
          verification: args.verification,
          description: normaliseDescription(args.description),
        }),
      ),
  });
}

function makeAddFeatureTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_add_feature',
    description: 'Append a feature under an existing slice.',
    input: z.object({
      taskId: TaskRefSchema,
      sliceId: SliceIdSchema,
      title: z.string().min(1),
      acceptanceCriteria: z.string(),
      description: z.string().optional(),
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        addFeatureHandler(ctx, {
          taskId: args.taskId,
          sliceId: args.sliceId,
          title: args.title,
          acceptanceCriteria: args.acceptanceCriteria,
          description: normaliseDescription(args.description),
        }),
      ),
  });
}

function makeAddAssertionTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_add_assertion',
    description: 'Append an assertion under an existing milestone, optionally linked to features.',
    input: z.object({
      taskId: TaskRefSchema,
      milestoneId: MilestoneIdSchema,
      title: z.string().min(1),
      assertion: z.string(),
      featureIds: z.array(FeatureIdSchema).optional(),
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        addAssertionHandler(ctx, {
          taskId: args.taskId,
          milestoneId: args.milestoneId,
          title: args.title,
          assertion: args.assertion,
          featureIds: args.featureIds,
        }),
      ),
  });
}

function makeActivateSliceTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_activate_slice',
    description:
      "Mark a slice active. Defaults its triage flag to the parent task's autopilot flag.",
    input: z.object({
      taskId: TaskRefSchema,
      sliceId: SliceIdSchema,
      triage: z.boolean().optional(),
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        activateSliceHandler(ctx, {
          taskId: args.taskId,
          sliceId: args.sliceId,
          triage: args.triage,
        }),
      ),
  });
}

function makeAutopilotTool(ctx: TaskStoreContext): Tool {
  return tool({
    name: 'task_autopilot',
    description: "Toggle a task's autopilotEnabled flag.",
    input: z.object({
      taskId: TaskRefSchema,
      enabled: z.boolean(),
    }),
    output: ResultEnvelopeSchema,
    execute: async (args) =>
      safeRun(() =>
        autopilotHandler(ctx, {
          taskId: args.taskId,
          enabled: args.enabled,
        }),
      ),
  });
}

//#endregion

//#region Public API

/** Names of the read-only observation tools. Exported so tests can assert against them. */
export const READ_ONLY_TASK_TOOL_NAMES: ReadonlyArray<string> = [
  'task_show',
  'task_list',
  'task_logs',
];

/**
 * Build the agent-facing wrappers for the Phase-7 task verb handlers. When
 * `readOnly` is true, only the observation tools are returned — mutators
 * are omitted entirely (rather than gated at runtime) so the model never
 * sees a tool it isn't allowed to invoke.
 */
export function taskTools(opts: TaskToolsOptions): ReadonlyArray<Tool> {
  const { ctx, readOnly } = opts;
  const readers: Tool[] = [
    makeShowTool(ctx),
    makeListTool(ctx),
    makeLogsTool(ctx),
  ];
  if (readOnly === true) {
    return readers;
  }
  const mutators: Tool[] = [
    makeCreateTool(ctx),
    makeMoveTool(ctx),
    makeLogTool(ctx),
    makeAttachTool(ctx),
    makeCommentTool(ctx),
    makeSteerTool(ctx),
    makePauseTool(ctx),
    makeUnpauseTool(ctx),
    makeArchiveTool(ctx),
    makeUnarchiveTool(ctx),
    makeDeleteTool(ctx),
    makeDuplicateTool(ctx),
    makeMergeTool(ctx),
    makePlanTool(ctx),
    makeAddMilestoneTool(ctx),
    makeAddSliceTool(ctx),
    makeAddFeatureTool(ctx),
    makeAddAssertionTool(ctx),
    makeActivateSliceTool(ctx),
    makeAutopilotTool(ctx),
  ];
  return [
    ...readers,
    ...mutators,
  ];
}

//#endregion
