/**
 * Wrapper script that owns the autonomous planner subprocess for one
 * manual task. Spawned by `planner-launcher.ts` via `bun run`. Reads
 * `NOETIC_TASK_DIR` (the leaf task) and `NOETIC_TASK_CWD` (the project
 * root) from env. Constructs an `AgentHarness` with the planner-attempt
 * memory layer mounted, then drives a Step-graph planner flow rooted at
 * `branch({route: hasHierarchyPredicate, ...})`. The flow's body steps
 * own the imperative audit→state→event commit sequence.
 */

import { basename, dirname } from 'node:path';

import { AgentHarness, createLocalFsAdapter, createLocalShellAdapter } from '@noetic/core';
import { DEFAULT_MODEL } from './defaults.js';
import type { TaskStoreContext } from './fs-store.js';
import { appendLog, loadTask } from './fs-store.js';
import type { PlannerFlowInput, PlannerOutcome, RunInterviewFn } from './hierarchy/planner-flow.js';
import { buildPlannerFlow } from './hierarchy/planner-flow.js';
import { loadPlanner } from './planner-state.js';
import { LogEntryKind } from './schemas.js';

//#region Types

const ENV_TASK_DIR = 'NOETIC_TASK_DIR';
const ENV_CWD = 'NOETIC_TASK_CWD';

export type RunPlannerInterviewFn = RunInterviewFn;

export interface RunPlannerOptions {
  readonly ctx?: TaskStoreContext;
  readonly taskDir?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly runInterviewFn?: RunPlannerInterviewFn;
  readonly maxQuestions?: number;
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
  // string rather than throwing, since the LLM responder already
  // handles the empty-context case.
  const path = `${args.ctx.projectRoot}/.noetic/tasks/${args.taskId}/description.md`;
  try {
    return await args.ctx.fs.readFileText(path);
  } catch {
    return '';
  }
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

  // Build the flow's Step graph + the memory layers it expects mounted.
  // Body steps reach the harness via `ctx.harness` so the flow doesn't
  // need a backreference at build time.
  const flow = buildPlannerFlow({
    storeCtx: ctx,
    model,
    runInterview: opts.runInterviewFn,
    maxQuestions: opts.maxQuestions,
  });

  const harness = new AgentHarness({
    name: 'noetic-planner',
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

  const flowInput: PlannerFlowInput = {
    taskId,
    task,
    description,
  };
  const flowCtx = harness.createContext({});
  // `harness.run` does not auto-initialise context layers; do it
  // manually using the layer set we already built (avoids relying on
  // `Context.layers`, which is an internal field on the impl).
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

  return {
    taskId,
    outcome,
  };
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
