/**
 * Wrapper script that owns the autonomous planner subprocess for one
 * manual task. Spawned by `planner-launcher.ts` via `bun run`. Reads
 * `NOETIC_TASK_DIR` (the leaf task) and `NOETIC_TASK_CWD` (the project
 * root) from env. Constructs a chat-shaped `AgentHarness` (see
 * `runner-harness.ts`) wired with the planner's role-specific terminal
 * tools and drives it through one or more turns until the agent calls
 * `submit_hierarchy` or `abandon_planning`. The IPC server (started in
 * a follow-up commit) keeps the runner addressable while the agent
 * works, so the TUI can chat with it live.
 */

import { basename, dirname } from 'node:path';

import { createLocalFsAdapter } from '@noetic/core';
import { createSteeringFileLayer } from '../../../memory/steering-file-layer.js';
import { createCodingTools } from '../../../tools/index.js';
import { AgentIpcServer, unlinkSocketSync } from './agent-ipc-server.js';
import { DEFAULT_MODEL } from './defaults.js';
import type { TaskStoreContext } from './fs-store.js';
import { appendLog, loadTask } from './fs-store.js';
import { createIpcAskUserService } from './ipc-ask-user-service.js';
import { createPlannerAttemptLayer } from './memory/planner-attempt-layer.js';
import { clearPlanner, loadPlanner, savePlanner } from './planner-state.js';
import type { PlannerOutcome } from './planner-tools.js';
import { createAbandonPlanningTool, createSubmitHierarchyTool } from './planner-tools.js';
import { createRunnerHarness, createRunnerSignal, runRunnerLoop } from './runner-harness.js';
import { LogEntryKind } from './schemas.js';

//#region Types

const ENV_TASK_DIR = 'NOETIC_TASK_DIR';
const ENV_CWD = 'NOETIC_TASK_CWD';

export interface RunPlannerOptions {
  readonly ctx?: TaskStoreContext;
  readonly taskDir?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly apiKey?: string;
}

export interface RunPlannerResult {
  readonly taskId: string;
  readonly outcome: PlannerOutcome;
}

//#endregion

//#region Helpers

function readEnv(name: string): string | null {
  const v = process.env[name];
  if (v === undefined || v.length === 0) {
    return null;
  }
  return v;
}

function nowIso(): string {
  return new Date().toISOString();
}

function projectRootFromTaskDir(taskDir: string): string {
  const tasksDir = dirname(taskDir);
  const noeticDir = dirname(tasksDir);
  return dirname(noeticDir);
}

function taskIdFromTaskDir(taskDir: string): string {
  return basename(taskDir);
}

async function loadDescription(args: {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
}): Promise<string> {
  // Description lives at `<taskDir>/description.md`. Missing file is
  // common for tasks created without `--description` — return empty
  // string rather than throwing.
  const path = `${args.ctx.projectRoot}/.noetic/tasks/${args.taskId}/description.md`;
  try {
    return await args.ctx.fs.readFileText(path);
  } catch {
    return '';
  }
}

const PLANNER_INSTRUCTIONS = `You are the Noetic task planner.

Your single job is to produce a structured plan for the task — a hierarchy of milestones, slices, and features — and submit it via the \`submit_hierarchy\` tool.

# Hierarchy concepts
- **Milestone**: a major phase or deliverable. Has verification criteria describing how to confirm the phase is complete. Aim for 2–4.
- **Slice**: a focused work unit inside a milestone, activatable on its own. Has verification criteria. Aim for 1–3 per milestone.
- **Feature**: a specific leaf deliverable inside a slice. Has acceptance criteria (a single concrete, testable string). Aim for 2–5 per slice.
- **Assertion** (optional): a milestone-level check that ties together one or more features by index.

# Conversation flow
1. Read the task title and description.
2. If the description is rich enough, draft a plan and submit it directly.
3. If anything is unclear, ask the user clarifying questions in chat. Keep questions short and answerable.
4. Push back on vague objectives. Challenge unrealistic scope and suggest phasing.
5. When you have enough context (usually after 0–4 clarifying turns), call \`submit_hierarchy\` exactly once with the final plan.

# Failure path
If the task is too underspecified to plan even after asking, call \`abandon_planning\` with a one-sentence reason. Do not silently produce a low-quality plan.

# Response style
- In chat turns, be concise. Short questions, no preamble.
- Do **not** emit raw JSON in chat. The hierarchy goes through \`submit_hierarchy\` only.`;

function buildInitialPrompt(args: {
  readonly title: string;
  readonly description: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Task: ${args.title}`);
  if (args.description.trim().length > 0) {
    lines.push('', '## Description', '', args.description.trim());
  } else {
    lines.push('', '_(no description provided)_');
  }
  lines.push('', 'Plan this task. Ask clarifying questions if needed, then call submit_hierarchy.');
  return lines.join('\n');
}

//#endregion

//#region Public API

export async function runPlanner(opts: RunPlannerOptions = {}): Promise<RunPlannerResult> {
  const taskDir = opts.taskDir ?? readEnv(ENV_TASK_DIR);
  if (taskDir === null) {
    throw new Error(`${ENV_TASK_DIR} env var is required to run the planner`);
  }
  const cwd = opts.cwd ?? readEnv(ENV_CWD) ?? process.cwd();
  const taskId = taskIdFromTaskDir(taskDir);
  const projectRoot = projectRootFromTaskDir(taskDir);
  const ctx: TaskStoreContext = opts.ctx ?? {
    fs: createLocalFsAdapter(),
    projectRoot,
  };

  const sidecar = await loadPlanner(ctx, taskId);
  if (sidecar !== null) {
    await appendLog(ctx, {
      taskId,
      entry: {
        kind: LogEntryKind.System,
        ts: nowIso(),
        message: `planner started (pid=${sidecar.pid})`,
      },
    });
  }

  const task = await loadTask(ctx, taskId);
  const description = await loadDescription({
    ctx,
    taskId,
  });

  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
  const model = opts.model ?? process.env.NOETIC_MODEL ?? DEFAULT_MODEL;

  const signal = createRunnerSignal<PlannerOutcome>();

  const submitTool = createSubmitHierarchyTool({
    storeCtx: ctx,
    taskId,
    signal,
  });
  const abandonTool = createAbandonPlanningTool({
    storeCtx: ctx,
    taskId,
    signal,
  });

  // Construct the IPC-backed ask-user service before tools so the
  // `AskUserQuestion` tool gets registered. The broadcaster is wired
  // up after the IPC server is constructed (server holds the client
  // set the broadcaster fans out to). Calls before that wiring become
  // no-ops, which is safe because the agent can't ask anything before
  // its first turn anyway.
  let serverRef: AgentIpcServer | null = null;
  const askUserService = createIpcAskUserService({
    broadcastRequest: (request) => {
      serverRef?.broadcastAskUserRequest(request);
    },
    broadcastCleared: (id) => {
      serverRef?.broadcastAskUserCleared(id);
    },
  });

  const codingTools = createCodingTools({
    cwd,
    fs: ctx.fs,
    askUserService,
  });

  const plannerAttemptLayer = createPlannerAttemptLayer({
    projectRoot: ctx.projectRoot,
  });
  const steeringLayer = createSteeringFileLayer();

  const { harness, threadId } = await createRunnerHarness({
    role: 'planner',
    taskId,
    cwd,
    apiKey,
    model,
    instructions: PLANNER_INSTRUCTIONS,
    tools: [
      ...codingTools,
      submitTool,
      abandonTool,
    ],
    memory: [
      plannerAttemptLayer,
      steeringLayer,
    ],
    fs: ctx.fs,
  });

  const initialPromptText = buildInitialPrompt({
    title: task.title,
    description,
  });
  // The IPC server's stream pump appends the framing item to chat.jsonl
  // when the harness emits it, so we don't write to disk here. The id
  // is stable per-task so re-spawns recognise it as the same framing.
  const initialMessage = {
    id: `planner-init-${taskId}`,
    type: 'message' as const,
    role: 'developer' as const,
    status: 'completed' as const,
    content: [
      {
        type: 'input_text' as const,
        text: initialPromptText,
      },
    ],
  };

  const ipcServer = new AgentIpcServer({
    harness,
    storeCtx: ctx,
    taskId,
    role: 'planner',
    runnerId: taskId,
    threadId,
    askUserService,
  });
  serverRef = ipcServer;
  await ipcServer.listen();
  // Re-read the sidecar before adding `socketPath` so we don't clobber
  // any control-surface mutation (pause/cancel/delete-guard) that may
  // have updated it between the runner's startup `loadPlanner` above
  // and now. If the sidecar was cleared while listen() was binding,
  // skip the write entirely — the runner is already orphaned.
  const currentSidecar = await loadPlanner(ctx, taskId);
  if (currentSidecar !== null) {
    await savePlanner(ctx, {
      ...currentSidecar,
      socketPath: ipcServer.getSocketPath(),
    });
  }

  const installSignalHandlers = (): (() => void) => {
    const onSignal = (signalName: string): void => {
      // Reject the runner signal so `runRunnerLoop`'s `await signal.done`
      // unwinds and the surrounding finally block can close the IPC
      // server cleanly. Without this rejection the await would block
      // forever and the OS would kill the process before unlink runs.
      signal.reject(new Error(`runner aborted by ${signalName}`));
      void ipcServer.close(`process-signal:${signalName}`);
    };
    const onSigInt = (): void => onSignal('SIGINT');
    const onSigTerm = (): void => onSignal('SIGTERM');
    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);
    return () => {
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
    };
  };
  const removeSignalHandlers = installSignalHandlers();

  // Belt-and-suspenders: if the process exits via an uncaught throw the
  // try/finally below doesn't run, so this 'exit' handler unlinks the
  // socket synchronously as a last resort. We use the top-level
  // `unlinkSocketSync` helper rather than an inline require so the
  // import surface stays in one place.
  const onExit = (): void => {
    unlinkSocketSync(ipcServer.getSocketPath());
  };
  process.on('exit', onExit);

  try {
    const outcome = await runRunnerLoop({
      harness,
      threadId,
      initialMessage,
      signal,
      storeCtx: ctx,
      taskId,
      nudge: {
        role: 'planner',
        askUserService,
        buildStalledOutcome: (): PlannerOutcome => ({
          status: 'failed',
          reason:
            'planner stalled — finished its turn without calling submit_hierarchy or AskUserQuestion',
        }),
      },
    });
    return {
      taskId,
      outcome,
    };
  } finally {
    process.off('exit', onExit);
    removeSignalHandlers();
    await ipcServer.close('runner-exit');
    // Always clear the sidecar on exit — without this, a stalled /
    // killed / crashed runner leaves `_planner.json` pointing at the
    // socket path `ipcServer.close()` just unlinked. The TUI would
    // then hand that dead path to its IPC client and surface
    // "disconnected: connect ENOENT <path>". The happy paths
    // (`submit_hierarchy` / `abandon_planning`) clear the sidecar too,
    // via `planner-flow.ts`, so this call is redundant but idempotent
    // (`rm --force` on a missing file is a no-op) on those paths.
    await clearPlanner(ctx, taskId).catch(() => {
      /* swallow — sidecar will be evicted by the next launcher's pid check */
    });
  }
}

//#endregion

//#region Script entry

if (import.meta.main) {
  runPlanner()
    .then((result) => {
      process.exit(result.outcome.status === 'completed' ? 0 : 1);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`planner-runner: ${message}\n`);
      process.exit(2);
    });
}

//#endregion
