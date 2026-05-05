/**
 * Wrapper script that owns the implementation-agent subprocess
 * lifecycle for a single feature. Spawned by `implementer-launcher.ts`
 * via `bun run`. Reads `NOETIC_TASK_DIR` (leaf task), `NOETIC_PARENT_TASK_ID`
 * (structured task whose hierarchy owns the feature), `NOETIC_FEATURE_ID`,
 * and `NOETIC_TASK_CWD` (the worktree to run in) from env. Constructs an
 * `AgentHarness` with full coding tools and the fix-feedback memory layer
 * mounted (seeded from any prior fix-lineage), then drives a Step-graph
 * implementer flow rooted at `step.run` wrapping the `react()` agent loop.
 *
 * On runner exit, commits writes in the order **audit → state → event**:
 *
 *   1. Append a `kind='system'` log entry on the leaf task.
 *   2. Atomically rewrite the parent feature's `loopState`:
 *      `validating` on success, `blocked` on failure / max-steps.
 *   3. Append a `feature:loopStateChanged` event on the parent task.
 *   4. Best-effort: clear `_implementer.json` on the leaf.
 */

import { basename, dirname } from '@noetic/code-agent/tasks/path-utils';
import { createLocalFsAdapter } from '@noetic/core';

import { createSteeringFileLayer } from '../../../memory/steering-file-layer.js';
import { createCodingTools } from '../../../tools/index.js';
import { AgentIpcServer, unlinkSocketSync } from './agent-ipc-server.js';
import { DEFAULT_MODEL } from './defaults.js';
import type { TaskStoreContext } from './fs-store.js';
import { appendEvent, appendLog } from './fs-store.js';
import { getTaskHierarchy } from './hierarchy/aggregate.js';
import type { FeatureLifecycleContext } from './hierarchy/feature-lifecycle.js';
import { applyFeatureLoopStateUpdate, markFeatureBlocked } from './hierarchy/feature-lifecycle.js';
import type { ImplementerOutcome } from './hierarchy/implementer-flow.js';
import { buildFixFeedbackSeed, loadAccumulatedIssues } from './hierarchy/implementer-flow.js';
import type { Assertion, Feature, MilestoneWithChildren } from './hierarchy/schemas.js';
import { DEFAULT_IMPLEMENTATION_RETRY_BUDGET, FeatureLoopState } from './hierarchy/schemas.js';
import { clearImplementer, loadImplementer, saveImplementer } from './implementer-state.js';
import {
  createImplementationBlockedTool,
  createImplementationDoneTool,
} from './implementer-tools.js';
import { createIpcAskUserService } from './ipc-ask-user-service.js';
import { createFixFeedbackLayer } from './memory/fix-feedback-layer.js';
import { taskDirPaths } from './paths.js';
import { createRunnerHarness, createRunnerSignal, runRunnerLoop } from './runner-harness.js';
import { EventKind, LogEntryKind } from './schemas.js';

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

/**
 * `<tasksRoot>/T-<id>` → tasksRoot. The task state lives directly under
 * the tasks-root (user-global `~/.noetic/tasks` by default); the
 * runner recovers the root from the task-dir env var so it can anchor
 * `taskDirPaths()` calls to the right location without trusting
 * `NOETIC_HOME` to still match what the launcher resolved.
 */
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

interface CommitExitWritesArgs {
  readonly ctx: TaskStoreContext;
  readonly leafTaskId: string;
  readonly parentTaskId: string;
  readonly featureId: string;
  readonly outcome: ImplementerOutcome;
}

interface CommitExitWritesResult {
  readonly previousLoopState: FeatureLoopState;
  readonly loopState: FeatureLoopState;
}

/**
 * Audit → state → event commit on runner exit. Pure — testable without
 * an AgentHarness. The leaf task gets the durable log line; the parent
 * gets the canonical loopState mutation and the bus event.
 */
export async function commitExitWrites(
  args: CommitExitWritesArgs,
): Promise<CommitExitWritesResult> {
  const ts = nowIso();

  const summary =
    args.outcome.status === 'completed'
      ? `implementer completed: ${args.outcome.summary}`
      : `implementer blocked: ${args.outcome.summary}`;
  await appendLog(args.ctx, {
    taskId: args.leafTaskId,
    entry: {
      kind: LogEntryKind.System,
      ts,
      message: summary,
    },
  });

  const parentCtx: FeatureLifecycleContext = {
    ...args.ctx,
    taskId: args.parentTaskId,
  };
  const change =
    args.outcome.status === 'completed'
      ? await applyFeatureLoopStateUpdate(parentCtx, {
          featureId: args.featureId,
          newLoopState: FeatureLoopState.Validating,
        })
      : await applyFeatureLoopStateUpdate(parentCtx, {
          featureId: args.featureId,
          newLoopState: FeatureLoopState.Blocked,
          blockedReason: args.outcome.blockedReason ?? args.outcome.summary,
        });

  const previousLoopState = change.changed?.previousLoopState ?? change.feature.loopState;
  const loopState = change.feature.loopState;

  await appendEvent(args.ctx, {
    taskId: args.parentTaskId,
    kind: EventKind.FeatureLoopStateChanged,
    payload: {
      featureId: args.featureId,
      leafTaskId: args.leafTaskId,
      previousLoopState,
      loopState,
      phase: 'exit',
      summary: args.outcome.summary,
    },
    ts,
  });

  await clearImplementer(args.ctx, args.leafTaskId).catch(() => {
    /* swallow — sidecar will be evicted by the next launcher's pid check */
  });

  return {
    previousLoopState,
    loopState,
  };
}

/**
 * Mark the feature blocked when the runner couldn't even start the
 * react loop (missing env, hierarchy not found, etc.). Mirrors the
 * shape of {@link commitExitWrites} but skips the success branch.
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
  await clearImplementer(args.ctx, args.leafTaskId).catch(() => {
    /* swallow */
  });
}

//#endregion

//#region Public API

/**
 * Run a single implementation-agent loop for a feature. Resolves once
 * the react loop has settled and the audit/state/event writes are
 * committed. The caller (or the script entry point) translates the
 * outcome into a process exit code (0 on completed, 1 on blocked).
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

  const sidecar = await loadImplementer(ctx, leafTaskId);
  if (sidecar !== null) {
    await appendLog(ctx, {
      taskId: leafTaskId,
      entry: {
        kind: LogEntryKind.System,
        ts: nowIso(),
        message: `implementer started (pid=${sidecar.pid}, feature=${featureId}, branch=${sidecar.branch})`,
      },
    });
  }

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
  // `maxSteps` previously bounded the react-loop iterations. With the
  // chat-shaped runner the agent self-terminates by calling a terminal
  // tool, so we no longer thread maxSteps into a step graph. The option
  // is kept on `RunImplementerOptions` for forward compatibility (a turn
  // budget could be re-introduced as a runner-loop guard) but is unused
  // here — silenced via destructure to keep the unused-locals lint clean.
  void DEFAULT_IMPLEMENTATION_RETRY_BUDGET;
  void opts.maxSteps;

  // Seed the fix-feedback layer from disk: prior plan + description +
  // accumulated assertion failures from this feature's fix lineage.
  // Description and lineage reads are independent — batch them so a
  // long lineage doesn't add latency on top of the description read.
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

  const signal = createRunnerSignal<ImplementerOutcome>();

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

  // Construct the IPC-backed ask-user service before tools so the
  // `AskUserQuestion` tool gets registered. The broadcaster is wired
  // up after the IPC server is constructed (server holds the client
  // set the broadcaster fans out to).
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
  });

  const initialPromptText = buildInitialPrompt({
    feature: found.feature,
    assertions: found.assertions,
    worktreeCwd: cwd,
  });
  // The IPC server's stream pump appends the framing item to chat.jsonl
  // when the harness emits it, so we don't write to disk here.
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

  const ipcServer = new AgentIpcServer({
    harness,
    storeCtx: ctx,
    taskId: leafTaskId,
    role: 'implementer',
    runnerId: featureId,
    threadId,
    askUserService,
  });
  serverRef = ipcServer;
  await ipcServer.listen();
  // Re-read the sidecar before adding `socketPath` so we don't clobber
  // any control-surface mutation that may have updated it between the
  // runner's startup `loadImplementer` above and now. If the sidecar
  // was cleared while listen() was binding, skip the write — runner
  // is already orphaned.
  const currentSidecar = await loadImplementer(ctx, leafTaskId);
  if (currentSidecar !== null) {
    await saveImplementer(ctx, {
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
  // socket synchronously as a last resort.
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
      taskId: leafTaskId,
      nudge: {
        role: 'implementer',
        askUserService,
        buildStalledOutcome: (): ImplementerOutcome => ({
          status: 'blocked',
          summary:
            'implementer stalled — finished its turn without calling signal_implementation_done, signal_implementation_blocked, or AskUserQuestion',
          blockedReason: 'agent stalled',
        }),
      },
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
