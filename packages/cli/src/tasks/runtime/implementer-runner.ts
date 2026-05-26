/**
 * Wrapper script that owns the implementation-agent subprocess
 * lifecycle for a single feature. Spawned by the implementer launcher
 * via `bun run`. Reads `NOETIC_TASK_DIR` (leaf task), `NOETIC_PARENT_TASK_ID`
 * (structured task whose hierarchy owns the feature), `NOETIC_FEATURE_ID`,
 * and `NOETIC_TASK_CWD` (the worktree to run in) from env. Constructs an
 * `AgentHarness` with full coding tools and the fix-feedback memory layer
 * mounted (seeded from any prior fix-lineage), then drives a chat-shaped
 * runner loop until the agent signals done or blocked.
 *
 * On runner exit, commits writes in the order **audit → state → event**:
 *
 *   1. Append a `kind='system'` log entry on the leaf task.
 *   2. Atomically rewrite the parent feature's `loopState`:
 *      `validating` on success, `blocked` on failure / max-steps.
 *   3. Append a `feature:loopStateChanged` event on the parent task.
 *
 * Subprocess lifecycle is tracked by the subprocess adapter's handle
 * manifest — no per-leaf sidecar file to manage.
 */

import { createSteeringFileLayer } from '../../memory/steering-file-layer.js';
import { createCodingTools } from '../../tools/index.js';
import { DEFAULT_MODEL } from './defaults.js';
import type { TaskStoreContext } from './implementer-runner-parts/code-agent.js';
import {
  appendChatItem,
  appendEvent,
  appendLog,
  basename,
  createIpcAskUserService,
  createRunnerHarness,
  dirname,
  EventKind,
  LogEntryKind,
  loadTask,
  readChatHistory,
  runnerSocketPath,
  saveTask,
  TaskPauseReason,
  taskDirPaths,
} from './implementer-runner-parts/code-agent.js';
import type { Item } from './implementer-runner-parts/core.js';
import {
  AgentIpcServer,
  createDetachedSignal,
  createLocalFsAdapter,
  createLocalShellAdapter,
  createNudgeMessage,
  createStallNudgeHook,
  runnableLoop,
  unlinkSocketSync,
} from './implementer-runner-parts/core.js';
import type {
  Assertion,
  Feature,
  FeatureLifecycleContext,
  ImplementerOutcome,
  MilestoneWithChildren,
} from './implementer-runner-parts/hierarchy.js';
import {
  buildFixFeedbackSeed,
  DEFAULT_IMPLEMENTATION_RETRY_BUDGET,
  FeatureLoopState,
  getTaskHierarchy,
  loadAccumulatedIssues,
  markFeatureBlocked,
} from './implementer-runner-parts/hierarchy.js';
import {
  createImplementationBlockedTool,
  createImplementationDoneTool,
} from './implementer-tools.js';
import { createFixFeedbackLayer } from './memory/fix-feedback-layer.js';

export type { ImplementerOutcome } from './hierarchy/implementer-flow.js';

//#region Types

const ENV_TASK_DIR = 'NOETIC_TASK_DIR';
const ENV_PARENT_TASK_ID = 'NOETIC_PARENT_TASK_ID';
const ENV_FEATURE_ID = 'NOETIC_FEATURE_ID';
const ENV_CWD = 'NOETIC_TASK_CWD';

export interface RunImplementerOptions {
  readonly ctx?: TaskStoreContext;
  readonly taskDir?: string;
  readonly parentTaskId?: string;
  readonly featureId?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly maxSteps?: number;
}

export interface RunImplementerResult {
  readonly taskId: string;
  readonly parentTaskId: string;
  readonly featureId: string;
  readonly outcome: ImplementerOutcome;
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

function findFeatureContext(
  milestones: ReadonlyArray<MilestoneWithChildren>,
  featureId: string,
): {
  feature: Feature;
  assertions: ReadonlyArray<Assertion>;
} | null {
  for (const milestone of milestones) {
    for (const slice of milestone.slices) {
      for (const feature of slice.features) {
        if (feature.id === featureId) {
          return {
            feature,
            assertions: milestone.assertions,
          };
        }
      }
    }
  }
  return null;
}

function buildPlanSummary(milestones: ReadonlyArray<MilestoneWithChildren>): string {
  const lines: string[] = [];
  for (const m of milestones) {
    lines.push(`- ${m.title} — ${m.verification}`);
    for (const s of m.slices) {
      lines.push(`  - ${s.title} — ${s.verification}`);
    }
  }
  return lines.join('\n');
}

async function loadParentDescription(args: {
  readonly ctx: TaskStoreContext;
  readonly parentTaskId: string;
}): Promise<string> {
  const { description } = taskDirPaths(args.ctx, args.parentTaskId);
  try {
    return await args.ctx.fs.readFileText(description);
  } catch {
    return '';
  }
}

const IMPLEMENTER_INSTRUCTIONS = `You are the Noetic implementer.

Your job is to implement a single feature in the current worktree using the available coding tools (read, write, edit, bash, grep, find, ls). When you are confident the acceptance criteria are met, call \`signal_implementation_done\` with a one-paragraph summary. If you cannot complete the feature in this attempt, call \`signal_implementation_blocked\` with a one-sentence reason — do not partially implement and pretend you finished.

# Working style
- Keep changes scoped to the feature. Don't refactor or restructure unrelated code.
- Read existing code before writing new code. Match the project's conventions.
- Run any tests you write or rely on before declaring done.
- The user can chat with you mid-task to steer or clarify. Treat any user turn as authoritative new context.

# Termination
You MUST end the run by calling exactly one of these tools:
- \`signal_implementation_done\` when the feature is implemented and the acceptance criteria are satisfied.
- \`signal_implementation_blocked\` when the feature cannot be implemented in this attempt.

Do not return without calling one of these tools.`;

function buildInitialPrompt(args: {
  feature: Feature;
  assertions: ReadonlyArray<Assertion>;
  worktreeCwd: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Feature: ${args.feature.title}`);
  if (args.feature.description !== null && args.feature.description.length > 0) {
    lines.push('', args.feature.description);
  }
  lines.push('', '## Acceptance criteria', '', args.feature.acceptanceCriteria);
  if (args.assertions.length > 0) {
    lines.push('', '## Milestone assertions');
    for (const a of args.assertions) {
      lines.push(`- ${a.title}: ${a.assertion}`);
    }
  }
  lines.push(
    '',
    `Working directory: ${args.worktreeCwd}.`,
    'Implement this feature, then call signal_implementation_done. If you get stuck, call signal_implementation_blocked.',
  );
  return lines.join('\n');
}

export { commitExitWrites } from './implementer-commit.js';

/**
 * Mark the feature blocked when the runner couldn't even start the
 * react loop (missing env, hierarchy not found, etc.).
 */
async function commitStartupFailure(args: {
  readonly ctx: TaskStoreContext;
  readonly leafTaskId: string;
  readonly parentTaskId: string;
  readonly featureId: string;
  readonly reason: string;
}): Promise<void> {
  const ts = nowIso();
  await appendLog(args.ctx, {
    taskId: args.leafTaskId,
    entry: {
      kind: LogEntryKind.System,
      ts,
      message: `implementer startup failed: ${args.reason}`,
    },
  });
  const parentCtx: FeatureLifecycleContext = {
    ...args.ctx,
    taskId: args.parentTaskId,
  };
  await markFeatureBlocked(parentCtx, args.featureId, args.reason);
  await appendEvent(args.ctx, {
    taskId: args.parentTaskId,
    kind: EventKind.FeatureLoopStateChanged,
    payload: {
      featureId: args.featureId,
      leafTaskId: args.leafTaskId,
      loopState: FeatureLoopState.Blocked,
      phase: 'startup-failure',
      reason: args.reason,
    },
    ts,
  });
}

async function escalateStalledImplementer(args: {
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
      role: 'implementer',
    },
    ts,
  });
}

//#endregion

//#region Public API

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

/**
 * Run a single implementation-agent loop for a feature.
 */
export async function runImplementer(
  opts: RunImplementerOptions = {},
): Promise<RunImplementerResult> {
  const taskDir = opts.taskDir ?? readEnv(ENV_TASK_DIR);
  if (taskDir === null) {
    throw new Error(`${ENV_TASK_DIR} env var is required to run the implementer`);
  }
  const parentTaskId = opts.parentTaskId ?? readEnv(ENV_PARENT_TASK_ID);
  if (parentTaskId === null) {
    throw new Error(`${ENV_PARENT_TASK_ID} env var is required to run the implementer`);
  }
  const featureId = opts.featureId ?? readEnv(ENV_FEATURE_ID);
  if (featureId === null) {
    throw new Error(`${ENV_FEATURE_ID} env var is required to run the implementer`);
  }
  const cwd = opts.cwd ?? readEnv(ENV_CWD) ?? process.cwd();

  const leafTaskId = taskIdFromTaskDir(taskDir);
  const tasksRoot = tasksRootFromTaskDir(taskDir);
  const ctx: TaskStoreContext = opts.ctx ?? {
    fs: createLocalFsAdapter(),
    projectRoot: cwd,
    tasksRoot,
  };

  await appendLog(ctx, {
    taskId: leafTaskId,
    entry: {
      kind: LogEntryKind.System,
      ts: nowIso(),
      message: `implementer started (pid=${process.pid}, feature=${featureId})`,
    },
  });

  const hierarchy = await getTaskHierarchy(ctx, parentTaskId);
  if (hierarchy === null) {
    await commitStartupFailure({
      ctx,
      leafTaskId,
      parentTaskId,
      featureId,
      reason: `parent task ${parentTaskId} has no hierarchy`,
    });
    throw new Error(`parent task ${parentTaskId} has no hierarchy`);
  }
  const found = findFeatureContext(hierarchy.milestones, featureId);
  if (found === null) {
    await commitStartupFailure({
      ctx,
      leafTaskId,
      parentTaskId,
      featureId,
      reason: `feature ${featureId} not found in parent ${parentTaskId}`,
    });
    throw new Error(`feature ${featureId} not found in parent ${parentTaskId}`);
  }

  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
  const model = opts.model ?? process.env.NOETIC_MODEL ?? DEFAULT_MODEL;
  void DEFAULT_IMPLEMENTATION_RETRY_BUDGET;
  void opts.maxSteps;

  const planText = buildPlanSummary(hierarchy.milestones);
  const [description, accumulatedIssues] = await Promise.all([
    loadParentDescription({
      ctx,
      parentTaskId,
    }),
    loadAccumulatedIssues({
      storeCtx: ctx,
      parentTaskId,
      featureId,
    }),
  ]);
  const fixFeedbackInitial = buildFixFeedbackSeed({
    plan: planText,
    description,
    accumulatedIssues,
    attempt: found.feature.implementationAttemptCount + 1,
  });

  const signal = createDetachedSignal<ImplementerOutcome>();

  const doneTool = createImplementationDoneTool({
    storeCtx: ctx,
    leafTaskId,
    parentTaskId,
    featureId,
    signal,
  });
  const blockedTool = createImplementationBlockedTool({
    storeCtx: ctx,
    leafTaskId,
    parentTaskId,
    featureId,
    signal,
  });

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

  const fixFeedbackLayer = createFixFeedbackLayer({
    initial: fixFeedbackInitial,
  });
  const steeringLayer = createSteeringFileLayer();

  const { harness, threadId } = await createRunnerHarness({
    role: 'implementer',
    taskId: leafTaskId,
    cwd,
    apiKey,
    model,
    instructions: IMPLEMENTER_INSTRUCTIONS,
    tools: [
      ...codingTools,
      doneTool,
      blockedTool,
    ],
    memory: [
      fixFeedbackLayer,
      steeringLayer,
    ],
    fs: ctx.fs,
    shell: createLocalShellAdapter(),
  });

  const initialPromptText = buildInitialPrompt({
    feature: found.feature,
    assertions: found.assertions,
    worktreeCwd: cwd,
  });
  const initialMessage = {
    id: `implementer-init-${leafTaskId}`,
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
    taskId: leafTaskId,
    role: 'implementer',
    runnerId: featureId,
  });

  const ipcServer = new AgentIpcServer({
    harness,
    chatHistoryStore: {
      readChatHistory: (id) => readChatHistory(ctx, id),
      appendChatItem: (id, item) => appendChatItem(ctx, id, item),
    },
    logger: async (id, entry) => {
      await appendLog(ctx, {
        taskId: id,
        entry: {
          kind: matchLogKind(entry.kind),
          ts: entry.ts,
          message: entry.message,
          meta: entry.meta,
        },
      });
    },
    taskId: leafTaskId,
    role: 'implementer',
    runnerId: featureId,
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

  const onExit = (): void => {
    unlinkSocketSync(ipcServer.getSocketPath());
  };
  process.on('exit', onExit);

  try {
    const priorItems: ReadonlyArray<Item> = await readChatHistory(ctx, leafTaskId);
    const nudge = createStallNudgeHook({
      harness,
      threadId,
      signal,
      nudgeMessage: createNudgeMessage({
        id: `runner-nudge-${leafTaskId}-${Date.now()}`,
      }),
      hasPendingExternal: () => askUserService.peek() !== null,
      onStall: () =>
        escalateStalledImplementer({
          ctx,
          taskId: leafTaskId,
        }),
      buildStalledOutcome: (): ImplementerOutcome => ({
        status: 'blocked',
        summary:
          'implementer stalled — finished its turn without calling signal_implementation_done, signal_implementation_blocked, or AskUserQuestion',
        blockedReason: 'agent stalled',
      }),
    });
    const outcome = await runnableLoop<ImplementerOutcome>({
      harness,
      threadId,
      priorItems,
      initialMessage,
      signal,
      afterFirstTurn: nudge,
    });
    return {
      taskId: leafTaskId,
      parentTaskId,
      featureId,
      outcome,
    };
  } finally {
    process.off('exit', onExit);
    removeSignalHandlers();
    await ipcServer.close('runner-exit');
  }
}

//#endregion

//#region Script entry

if (import.meta.main) {
  runImplementer()
    .then((result) => {
      process.exit(result.outcome.status === 'completed' ? 0 : 1);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`implementer-runner: ${message}\n`);
      process.exit(2);
    });
}

//#endregion
