import { resolve } from 'node:path';
import type { Command, LocalCommandCall } from '../../types.js';
import { startAgentCiRun } from '../tasks/agent-ci-launcher.js';
import { openTasksDatabase } from '../tasks/db/index.js';
import { taskWorktreeId } from '../tasks/db/schema.js';
import { loadProjectWorktrees } from '../tasks/git.js';
import { upsertWorktreeTask } from '../tasks/reconcile.js';

const call: LocalCommandCall = async (args, ctx) => {
  const workflow = args.trim();
  if (workflow.length === 0) {
    return {
      type: 'text',
      value: 'Usage: /agent-ci <workflow-file>',
    };
  }

  const cwd = resolve(ctx.cwd);
  const worktrees = await loadProjectWorktrees(cwd);
  const current = worktrees.find((worktree) => worktree.current) ?? null;
  if (current === null) {
    return {
      type: 'text',
      value: 'agent-ci: not inside a tracked git worktree (run from a feature worktree)',
    };
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
    const result = startAgentCiRun({
      db: opened.db,
      taskId,
      workflow,
      cwd: current.path,
    });
    return {
      type: 'text',
      value: `Started agent-ci run (pid=${result.pid}, session=${result.sessionId}) for ${result.workflow}`,
    };
  } finally {
    opened.close();
  }
};

export const agentCi: Command = {
  type: 'local',
  name: 'agent-ci',
  description: 'Launch a tracked agent-ci review for the current worktree',
  load: async () => ({
    call,
  }),
};
