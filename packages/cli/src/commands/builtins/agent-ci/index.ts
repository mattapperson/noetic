import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { createLocalFsAdapter } from '@noetic/core';

import type { Command, LocalCommandCall, LocalCommandResult } from '../../types.js';
import { AgentCiSpawnError, startAgentCiRun } from '../tasks/agent-ci-launcher.js';
import type { TaskStoreContext } from '../tasks/fs-store.js';
import { saveTask, tryLoadTask } from '../tasks/fs-store.js';
import type { ProjectWorktree } from '../tasks/git.js';
import { loadProjectWorktrees } from '../tasks/git.js';
import type { Task } from '../tasks/schemas.js';
import {
  AutopilotState,
  ID_LENGTH,
  IdPrefix,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '../tasks/schemas.js';

//#region Workflow resolution

interface ResolvedWorkflow {
  readonly absolute: string;
  readonly display: string;
}

interface ResolveWorkflowArgs {
  readonly worktree: ProjectWorktree;
  readonly rawArg: string;
}

type WorkflowResolution =
  | {
      kind: 'ok';
      workflow: ResolvedWorkflow;
    }
  | {
      kind: 'error';
      message: string;
    };

function resolveWorkflow(args: ResolveWorkflowArgs): WorkflowResolution {
  const candidate = isAbsolute(args.rawArg)
    ? args.rawArg
    : resolve(args.worktree.path, args.rawArg);
  const resolvedRoot = resolve(args.worktree.path);
  const rel = relative(resolvedRoot, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return {
      kind: 'error',
      message: `agent-ci: workflow ${args.rawArg} is outside the worktree`,
    };
  }
  if (!existsSync(candidate)) {
    return {
      kind: 'error',
      message: `agent-ci: workflow file not found: ${args.rawArg}`,
    };
  }
  if (!statSync(candidate).isFile()) {
    return {
      kind: 'error',
      message: `agent-ci: workflow path is not a file: ${args.rawArg}`,
    };
  }
  return {
    kind: 'ok',
    workflow: {
      absolute: candidate,
      display: rel,
    },
  };
}

//#endregion

//#region Task ID + ensure

/**
 * Deterministic FS-shaped task id for a worktree pair. The hash domain
 * is `(projectRoot, worktreePath)` so the same worktree always lands
 * on the same `T-<10>` id; the legacy SQLite id (sha256 hex) is
 * unrelated to this one because the FS schema requires the `T-<10>`
 * format.
 */
function deterministicWorktreeTaskId(projectRoot: string, worktreePath: string): string {
  const digest = createHash('sha256')
    .update(projectRoot)
    .update('\0')
    .update(worktreePath)
    .digest('base64url');
  return `${IdPrefix.Task}-${digest.slice(0, ID_LENGTH)}`;
}

interface EnsureTaskArgs {
  readonly ctx: TaskStoreContext;
  readonly worktree: ProjectWorktree;
  readonly taskId: string;
  readonly now: string;
}

/**
 * Idempotent: load an existing task or persist a fresh worktree-source
 * record. Newly-created records start in `not_started`; existing records
 * retain their lifecycle state so calling /agent-ci on a
 * `needs_changes` task simply runs the review again.
 */
async function ensureWorktreeTask(args: EnsureTaskArgs): Promise<Task> {
  const existing = await tryLoadTask(args.ctx, args.taskId);
  if (existing !== null) {
    const next: Task = {
      ...existing,
      branch: args.worktree.branch,
      headSha: args.worktree.headSha,
      worktreePath: args.worktree.path,
      updatedAt: args.now,
      lastSeenAt: args.now,
    };
    await saveTask(args.ctx, next);
    return next;
  }
  const fresh: Task = {
    id: args.taskId,
    source: TaskSource.Worktree,
    title: args.worktree.branch ?? args.worktree.path,
    projectRoot: args.worktree.projectRoot,
    worktreePath: args.worktree.path,
    branch: args.worktree.branch,
    headSha: args.worktree.headSha,
    reviewStatus: TaskReviewStatus.NotStarted,
    lifecycleStatus: TaskLifecycleStatus.Active,
    paused: false,
    pauseReason: null,
    archivedAt: null,
    hierarchyStatus: null,
    autopilotEnabled: false,
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: null,
    createdAt: args.now,
    updatedAt: args.now,
    lastSeenAt: args.now,
  };
  await saveTask(args.ctx, fresh);
  return fresh;
}

//#endregion

//#region Public API

type LoadProjectWorktreesFn = (cwd: string) => Promise<ProjectWorktree[]>;
type StartAgentCiRunFn = typeof startAgentCiRun;

export interface RunAgentCiArgs {
  readonly rawArg: string;
  readonly cwd: string;
  readonly loadProjectWorktreesFn?: LoadProjectWorktreesFn;
  readonly startAgentCiRunFn?: StartAgentCiRunFn;
  /** Test seam: inject a hermetic FS-backed task store. */
  readonly ctx?: TaskStoreContext;
  readonly now?: string;
}

export async function runAgentCiCommand(args: RunAgentCiArgs): Promise<string> {
  const trimmed = args.rawArg.trim();
  if (trimmed.length === 0) {
    return 'Usage: /agent-ci <workflow-file>';
  }

  const loadWorktrees = args.loadProjectWorktreesFn ?? loadProjectWorktrees;
  const startRun = args.startAgentCiRunFn ?? startAgentCiRun;
  const cwd = resolve(args.cwd);
  const worktrees = await loadWorktrees(cwd);
  const current = worktrees.find((worktree) => worktree.current) ?? null;
  if (current === null) {
    return 'agent-ci: not inside a tracked git worktree (run from a feature worktree)';
  }

  const resolution = resolveWorkflow({
    worktree: current,
    rawArg: trimmed,
  });
  if (resolution.kind === 'error') {
    return resolution.message;
  }

  const ctx: TaskStoreContext = args.ctx ?? {
    fs: createLocalFsAdapter(),
    projectRoot: current.projectRoot,
  };
  const now = args.now ?? new Date().toISOString();
  const taskId = deterministicWorktreeTaskId(current.projectRoot, current.path);

  try {
    await ensureWorktreeTask({
      ctx,
      worktree: current,
      taskId,
      now,
    });
    const result = await startRun({
      ctx,
      taskId,
      workflow: resolution.workflow.display,
      cwd: current.path,
      now,
    });
    return `Started agent-ci run (pid=${result.pid}, session=${result.sessionId}) for ${result.workflow}`;
  } catch (err) {
    if (err instanceof AgentCiSpawnError) {
      return `agent-ci: ${err.message}`;
    }
    throw err;
  }
}

//#endregion

//#region Command registration

const call: LocalCommandCall = async (args, ctx): Promise<LocalCommandResult> => {
  const value = await runAgentCiCommand({
    rawArg: args,
    cwd: ctx.cwd,
  });
  return {
    type: 'text',
    value,
  };
};

export const agentCi: Command = {
  type: 'local',
  name: 'agent-ci',
  description: 'Launch a tracked agent-ci review for the current worktree',
  load: async () => ({
    call,
  }),
};

//#endregion
