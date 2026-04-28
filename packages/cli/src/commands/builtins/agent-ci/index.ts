import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import type { Command, LocalCommandCall, LocalCommandResult } from '../../types.js';
import { AgentCiSpawnError, startAgentCiRun } from '../tasks/agent-ci-launcher.js';
import { openTasksDatabase } from '../tasks/db/index.js';
import { taskWorktreeId } from '../tasks/db/schema.js';
import type { ProjectWorktree } from '../tasks/git.js';
import { loadProjectWorktrees } from '../tasks/git.js';
import { upsertWorktreeTask } from '../tasks/reconcile.js';

interface ResolvedWorkflow {
  absolute: string;
  display: string;
}

interface ResolveWorkflowArgs {
  worktree: ProjectWorktree;
  rawArg: string;
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

type LoadProjectWorktreesFn = (cwd: string) => Promise<ProjectWorktree[]>;
type StartAgentCiRunFn = typeof startAgentCiRun;

export interface RunAgentCiArgs {
  rawArg: string;
  cwd: string;
  loadProjectWorktreesFn?: LoadProjectWorktreesFn;
  startAgentCiRunFn?: StartAgentCiRunFn;
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

  const opened = openTasksDatabase(cwd);
  try {
    upsertWorktreeTask({
      db: opened.db,
      projectRoot: current.projectRoot,
      worktreePath: current.path,
      branch: current.branch,
      headSha: current.headSha,
    });
    const taskId = taskWorktreeId(current.projectRoot, current.path);
    const result = startRun({
      db: opened.db,
      taskId,
      workflow: resolution.workflow.display,
      cwd: current.path,
    });
    return `Started agent-ci run (pid=${result.pid}, session=${result.sessionId}) for ${result.workflow}`;
  } catch (err) {
    if (err instanceof AgentCiSpawnError) {
      return `agent-ci: ${err.message}`;
    }
    throw err;
  } finally {
    opened.close();
  }
}

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
