import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { deterministicWorktreeTaskId } from '@noetic/code-agent/tasks';
import type { Task } from '@noetic/code-agent/tasks/schema';
import {
  AutopilotState,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { saveTask, tryLoadTask } from '@noetic/code-agent/tasks/store/fs-node';
import type { ProjectWorktree } from '@noetic/code-agent/tasks/worktree-node';
import { loadProjectWorktrees } from '@noetic/code-agent/tasks/worktree-node';
import { createLocalFsAdapter, createLocalShellAdapter } from '@noetic/core';
import type { Command, LocalCommandCall, LocalCommandResult } from '../../types.js';
import { AgentCiSpawnError, startAgentCiRun } from '../tasks/agent-ci-launcher.js';

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

  const shell = createLocalShellAdapter();
  const loadWorktrees =
    args.loadProjectWorktreesFn ?? ((cwd: string) => loadProjectWorktrees(cwd, shell));
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
  const taskId = await deterministicWorktreeTaskId(current.projectRoot, current.path);

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
