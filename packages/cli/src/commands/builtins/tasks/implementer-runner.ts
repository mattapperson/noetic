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

import { basename, dirname } from 'node:path';
import { AgentHarness, createLocalFsAdapter, createLocalShellAdapter } from '@noetic/core';

import { createCodingTools } from '../../../tools/index.js';
import { DEFAULT_MODEL } from './defaults.js';
import type { TaskStoreContext } from './fs-store.js';
import { appendEvent, appendLog } from './fs-store.js';
import { getTaskHierarchy } from './hierarchy/aggregate.js';
import type { FeatureLifecycleContext } from './hierarchy/feature-lifecycle.js';
import { applyFeatureLoopStateUpdate, markFeatureBlocked } from './hierarchy/feature-lifecycle.js';
import type { ImplementerFlowInput, ImplementerOutcome } from './hierarchy/implementer-flow.js';
import {
  buildFixFeedbackSeed,
  buildImplementerFlow,
  loadAccumulatedIssues,
} from './hierarchy/implementer-flow.js';
import type { Assertion, Feature, MilestoneWithChildren } from './hierarchy/schemas.js';
import { DEFAULT_IMPLEMENTATION_RETRY_BUDGET, FeatureLoopState } from './hierarchy/schemas.js';
import { clearImplementer, loadImplementer } from './implementer-state.js';
import { EventKind, LogEntryKind } from './schemas.js';

export type { ImplementerOutcome, RunReactFn } from './hierarchy/implementer-flow.js';

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
  /** Test seam: replace the react-loop executor with a stub. */
  readonly runReactFn?: import('./hierarchy/implementer-flow.js').RunReactFn;
  readonly maxSteps?: number;
}

export interface RunImplementerResult {
  readonly taskId: string;
  readonly parentTaskId: string;
  readonly featureId: string;
  readonly outcome: ImplementerOutcome;
  readonly previousLoopState: FeatureLoopState;
  readonly loopState: FeatureLoopState;
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
 * `<projectRoot>/.noetic/tasks/T-<id>` → projectRoot. Strips three path
 * segments: the task id, the literal `tasks` directory, and the literal
 * `.noetic` directory.
 */
function projectRootFromTaskDir(taskDir: string): string {
  const tasksDir = dirname(taskDir);
  const noeticDir = dirname(tasksDir);
  return dirname(noeticDir);
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
  const path = `${args.ctx.projectRoot}/.noetic/tasks/${args.parentTaskId}/description.md`;
  try {
    return await args.ctx.fs.readFileText(path);
  } catch {
    return '';
  }
}

function buildPrompt(args: {
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
    'Use the available tools to make code changes that satisfy the acceptance criteria.',
    'When you are confident the feature is complete, stop emitting tool calls and summarize what you did.',
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
  const projectRoot = projectRootFromTaskDir(taskDir);
  const ctx: TaskStoreContext = opts.ctx ?? {
    fs: createLocalFsAdapter(),
    projectRoot,
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
  const maxSteps = opts.maxSteps ?? DEFAULT_IMPLEMENTATION_RETRY_BUDGET;

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

  const flow = buildImplementerFlow({
    model,
    maxSteps,
    runReact: opts.runReactFn,
    fixFeedbackInitial,
  });

  const harness = new AgentHarness({
    name: 'noetic-implementer',
    fs: ctx.fs,
    shell: createLocalShellAdapter(),
    params: {
      model,
    },
    llm: {
      provider: 'openrouter',
      apiKey,
    },
    memory: [
      ...flow.layers,
    ],
    initialCwd: cwd,
  });

  const tools = createCodingTools({
    cwd,
    fs: ctx.fs,
  });

  const prompt = buildPrompt({
    feature: found.feature,
    assertions: found.assertions,
    worktreeCwd: cwd,
  });

  const flowInput: ImplementerFlowInput = {
    feature: found.feature,
    assertions: found.assertions,
    worktreeCwd: cwd,
    prompt,
    tools,
  };
  const flowCtx = harness.createContext({});
  // `harness.run` does not auto-init layers; do it manually using
  // `flow.layers` (avoids reading the internal `Context.layers`
  // field). Ensures the fix-feedback layer's seeded state is
  // visible on the first recall.
  if (flow.layers.length > 0) {
    await harness.initLayers(
      [
        ...flow.layers,
      ],
      flowCtx,
      harness.config.storage,
    );
  }
  const outcome = await harness.run(flow.step, flowInput, flowCtx);

  const { previousLoopState, loopState } = await commitExitWrites({
    ctx,
    leafTaskId,
    parentTaskId,
    featureId,
    outcome,
  });

  return {
    taskId: leafTaskId,
    parentTaskId,
    featureId,
    outcome,
    previousLoopState,
    loopState,
  };
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
