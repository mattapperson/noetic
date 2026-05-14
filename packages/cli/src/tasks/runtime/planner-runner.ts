/**
 * Wrapper script that owns the autonomous planner subprocess for one
 * manual task. Spawned by the planner launcher via `bun run`. Reads
 * `NOETIC_TASK_DIR` (the leaf task) and `NOETIC_TASK_CWD` (the project
 * root) from env. Constructs a chat-shaped `AgentHarness` (see
 * `runner-harness.ts`) wired with the planner's role-specific terminal
 * tools and drives it through one or more turns until the agent calls
 * `submit_hierarchy` or `abandon_planning`. The IPC server keeps the
 * runner addressable while the agent works, so the TUI can chat with
 * it live.
 */

import {
  appendChatItem,
  createIpcAskUserService,
  createRunnerHarness,
  readChatHistory,
} from '@noetic/code-agent/tasks';
import { basename, dirname } from '@noetic/code-agent/tasks/path-utils';
import { EventKind, LogEntryKind, TaskPauseReason } from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import {
  appendEvent,
  appendLog,
  loadTask,
  runnerSocketPath,
  saveTask,
  taskDirPaths,
} from '@noetic/code-agent/tasks/store/fs-node';
import type { Item } from '@noetic-tools/core';
import {
  createDetachedSignal,
  createNudgeMessage,
  createStallNudgeHook,
  runnableLoop,
} from '@noetic-tools/core';
import {
  AgentIpcServer,
  createLocalFsAdapter,
  createLocalShellAdapter,
  unlinkSocketSync,
} from '@noetic/platform-node';
import { createSteeringFileLayer } from '../../memory/steering-file-layer.js';
import { createCodingTools } from '../../tools/index.js';
import { DEFAULT_MODEL } from './defaults.js';
import { createPlannerAttemptLayer } from './memory/planner-attempt-layer.js';
import type { PlannerOutcome } from './planner-tools.js';
import { createAbandonPlanningTool, createSubmitHierarchyTool } from './planner-tools.js';

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

function tasksRootFromTaskDir(taskDir: string): string {
  return dirname(taskDir);
}

function taskIdFromTaskDir(taskDir: string): string {
  return basename(taskDir);
}

async function loadDescription(args: {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
}): Promise<string> {
  const { description } = taskDirPaths(args.ctx, args.taskId);
  try {
    return await args.ctx.fs.readFileText(description);
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

async function escalateStalledPlanner(args: {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
}): Promise<void> {
  const ts = nowIso();
  const task = await loadTask(args.ctx, args.taskId);
  await saveTask(args.ctx, {
    ...task,
    paused: true,
    pauseReason: TaskPauseReason.AgentStalled,
    updatedAt: ts,
  });
  await appendEvent(args.ctx, {
    kind: EventKind.TaskUpdated,
    taskId: args.taskId,
    payload: {
      phase: 'agent_stalled',
      role: 'planner',
    },
    ts,
  });
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
  const tasksRoot = tasksRootFromTaskDir(taskDir);
  const ctx: TaskStoreContext = opts.ctx ?? {
    fs: createLocalFsAdapter(),
    projectRoot: cwd,
    tasksRoot,
  };

  await appendLog(ctx, {
    taskId,
    entry: {
      kind: LogEntryKind.System,
      ts: nowIso(),
      message: `planner started (pid=${process.pid})`,
    },
  });

  const task = await loadTask(ctx, taskId);
  const description = await loadDescription({
    ctx,
    taskId,
  });

  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
  const model = opts.model ?? process.env.NOETIC_MODEL ?? DEFAULT_MODEL;

  const signal = createDetachedSignal<PlannerOutcome>();

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

  // Ask-user service with broadcaster wired after the IPC server is
  // constructed (server holds the client set the broadcaster fans out
  // to). Calls before that wiring become no-ops, which is safe because
  // the agent can't ask anything before its first turn anyway.
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
    shell: createLocalShellAdapter(),
  });

  const initialPromptText = buildInitialPrompt({
    title: task.title,
    description,
  });
  // The IPC server's stream pump appends the framing item to chat.jsonl
  // when the harness emits it, so we don't write to disk here.
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

  const socketPath = runnerSocketPath(ctx, {
    taskId,
    role: 'planner',
  });

  const ipcServer = new AgentIpcServer({
    harness,
    chatHistoryStore: {
      readChatHistory: (id) => readChatHistory(ctx, id),
      appendChatItem: (id, item) => appendChatItem(ctx, id, item),
    },
    logger: async (id, entry) => {
      const kind = matchLogKind(entry.kind);
      await appendLog(ctx, {
        taskId: id,
        entry: {
          kind,
          ts: entry.ts,
          message: entry.message,
          meta: entry.meta,
        },
      });
    },
    taskId,
    role: 'planner',
    runnerId: 'planner',
    threadId,
    socketPath,
    askUserService,
    fs: ctx.fs,
  });
  serverRef = ipcServer;
  await ipcServer.listen();

  const installSignalHandlers = (): (() => void) => {
    const onSignal = (signalName: string): void => {
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
  // socket synchronously as a last resort.
  const onExit = (): void => {
    unlinkSocketSync(ipcServer.getSocketPath());
  };
  process.on('exit', onExit);

  try {
    const priorItems: ReadonlyArray<Item> = await readChatHistory(ctx, taskId);
    const nudge = createStallNudgeHook({
      harness,
      threadId,
      signal,
      nudgeMessage: createNudgeMessage({
        id: `runner-nudge-${taskId}-${Date.now()}`,
      }),
      hasPendingExternal: () => askUserService.peek() !== null,
      onStall: () =>
        escalateStalledPlanner({
          ctx,
          taskId,
        }),
      buildStalledOutcome: (): PlannerOutcome => ({
        status: 'failed',
        reason:
          'planner stalled — finished its turn without calling submit_hierarchy or AskUserQuestion',
      }),
    });
    const outcome = await runnableLoop<PlannerOutcome>({
      harness,
      threadId,
      priorItems,
      initialMessage,
      signal,
      afterFirstTurn: nudge,
    });
    return {
      taskId,
      outcome,
    };
  } finally {
    process.off('exit', onExit);
    removeSignalHandlers();
    await ipcServer.close('runner-exit');
  }
}

//#endregion

//#region Helpers

type AllowedLogKind = (typeof LogEntryKind)[keyof typeof LogEntryKind];

function matchLogKind(kind: string): AllowedLogKind {
  if (
    kind === LogEntryKind.Log ||
    kind === LogEntryKind.Comment ||
    kind === LogEntryKind.Steer ||
    kind === LogEntryKind.System
  ) {
    return kind;
  }
  return LogEntryKind.System;
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
