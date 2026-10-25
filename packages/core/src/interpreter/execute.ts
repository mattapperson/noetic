import type { ContextData, ContextLayer, LayerStateStore } from '@noetic-tools/context';
import type {
  Context,
  Step,
  StepRunCode,
  StepSpawn,
  StepSubprocessRequest,
  StorageAdapter,
  SubprocessAdapter,
} from '@noetic-tools/types';
import { frameworkCast, NoeticErrorImpl } from '@noetic-tools/types';
import { emitFrameworkEvent, getBroadcaster, shouldEmit } from '../runtime/broadcaster-utils';
import { ContextImpl } from '../runtime/context-impl';
import type { StepLedger } from '../runtime/durable/step-ledger';
import { REPLAY_KEY_PREFIX } from '../runtime/durable/step-ledger';
import type { EventBroadcaster } from '../runtime/event-broadcaster';
import { DetachedHandleImpl } from '../util/detached-handle';
import { executeAcpAgent } from './execute-acp-agent';
import {
  executeCallModel,
  executeInvokeTool,
  executeRunCode,
  executeSpawn,
  executeWithContext,
} from './execute-action';
import {
  executeConditional,
  executeInParallel,
  executeLoop,
  executeSchedule,
} from './execute-control';
import { executeDecide } from './execute-decide';
import { isMutableContext } from './typeguards';

//#region Constants

const MAX_DEPTH = 64;

//#endregion

//#region Helpers

/**
 * Return the underlying `ContextImpl` when the context is one we produced
 * in-process. Out-of-process descendants reach us through the adapter
 * boundary and are not `ContextImpl` instances, so frontier bookkeeping is
 * a no-op for them.
 */
function asContextImpl(ctx: Context): ContextImpl | null {
  return ctx instanceof ContextImpl ? ctx : null;
}

/**
 * Extract the parent's context layers and layer-state store so `executeSpawn`
 * can propagate them to the child context per `specs/04-spawn.md`: when a
 * spawn step has no explicit `context` config, parent layers inherit and their
 * `onSpawn`/`onReturn` hooks run across the boundary.
 *
 * `ctx.harness.layerStateStore` is not on the public `AgentHarnessContract`
 * (it's an internal runtime surface). Accessing it via `frameworkCast`
 * matches the internal-only pattern used elsewhere in the interpreter.
 */
interface HarnessWithLayerStore {
  layerStateStore: LayerStateStore;
  config?: {
    storage?: StorageAdapter;
  };
}

function harnessWithLayerStore<TContext>(ctx: Context<TContext>): HarnessWithLayerStore {
  return frameworkCast<HarnessWithLayerStore>(ctx.harness);
}

function buildSpawnOpts<TContext>(ctx: Context<TContext>): {
  itemSchemas: Context['itemSchemas'];
  parentLayers: ContextLayer[] | undefined;
  layerStore: LayerStateStore;
} {
  const baseCtx = frameworkCast<Context>(ctx);
  return {
    itemSchemas: baseCtx.itemSchemas,
    parentLayers: baseCtx.layers,
    layerStore: harnessWithLayerStore(baseCtx).layerStateStore,
  };
}

/**
 * Resolve the per-step framework-event emit option. `callModel`, `decide`, and
 * the harness step kinds carry an `emit` field; every other kind defaults to
 * enabled.
 */
function resolveStepEmit<TContext, I, O>(
  step: Step<TContext, I, O>,
): boolean | ((eventType: string, data: Record<string, unknown>) => boolean) | undefined {
  if (step.kind === 'callModel' || step.kind === 'decide' || step.kind === 'acp-agent') {
    return step.emit;
  }
  return undefined;
}

/**
 * Resolve the subprocess adapter that should handle dispatch for this step.
 * Precedence is `step.subprocess ?? ctx.harness.subprocess`. Per-call
 * `detachedSpawn` overrides layer above this in the harness itself.
 */
function resolveStepAdapter<TContext, I, O>(
  step: Step<TContext, I, O>,
  ctx: Context<TContext>,
): SubprocessAdapter {
  if ((step.kind === 'runCode' || step.kind === 'spawn') && step.subprocess) {
    return step.subprocess;
  }
  return ctx.harness.subprocess;
}

/**
 * Dispatch a run/spawn step through the resolved subprocess adapter.
 *
 * The `_localExecutor` closure carries the in-process fallback path — the
 * in-memory adapter invokes it directly, preserving the pre-refactor
 * dispatch semantics including parent-context inheritance, layer lifecycle,
 * and synchronous error propagation. Out-of-process adapters ignore
 * `_localExecutor` and run the step in a child runtime.
 *
 * `executionId` names the context the step body runs in: `ctx.id` for a
 * `runCode`, the pre-allocated child id for a `spawn`.
 */
async function dispatchViaAdapter<TContext, I, O>(
  step: StepRunCode<TContext, I, O> | StepSpawn<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
  executionId: string,
  executor: () => Promise<O>,
): Promise<O> {
  const adapter = resolveStepAdapter(step, ctx);
  const request: StepSubprocessRequest = {
    kind: 'step',
    stepId: step.id,
    serializedInput: input,
    executionId,
    overrides: {
      threadId: ctx.threadId,
      resourceId: ctx.resourceId,
    },
    _localExecutor: () => executor(),
  };
  const spawnPromise = adapter.spawn(request);
  const handle = new DetachedHandleImpl<O>({
    id: executionId,
    stepId: step.id,
    adapter,
    spawnPromise,
  });
  return handle.await();
}

/**
 * @internal
 * Dispatch a step at the per-kind handler level without adapter routing.
 *
 * Used as the top-level `_localExecutor` for `StepRunCode` / `StepSpawn`
 * dispatches: the outer adapter call already recorded the request, so
 * running the handler directly avoids a re-entrant adapter round-trip
 * inside the same logical step. Nested step dispatches (e.g. `executeSpawn`
 * descending into `step.child`) still go through `execute()` and route
 * through the adapter as normal, so per-step overrides on descendants
 * continue to work.
 */
export async function executeNoAdapter<TContext, I, O>(
  step: Step<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
): Promise<O> {
  switch (step.kind) {
    case 'runCode':
      return executeRunCode(step, input, ctx);
    case 'spawn':
      return executeSpawn(step, input, ctx, (s, i, c) => execute(s, i, c), buildSpawnOpts(ctx));
    default:
      // Kinds that don't currently route through the adapter (callModel,
      // invokeTool, conditional, inParallel, withContext, loop, schedule).
      // Delegate back to `execute()`
      // so they exercise the normal dispatch table, framework-event emits,
      // abort checks, and depth guard.
      return execute(step, input, ctx);
  }
}

/**
 * @internal
 * The ledger key this dispatch records and replays under, or undefined when the
 * step bypasses the ledger (spec 23a § Identity). A `durable: false` step and a
 * `schedule` (which never completes) are neither replayed nor recorded; the opt-out
 * covers this step only, so its children still resolve their own keys. A
 * `replayKey` replaces the positional path with `key:<key>`. A throwing `replayKey`
 * costs this dispatch its durability, not its run: the step executes unrecorded.
 */
export function resolveLedgerKey<TContext, I, O>(
  step: Step<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
): string | undefined {
  const impl = asContextImpl(frameworkCast<Context>(ctx));
  if (!impl?.ledger || step.id.length === 0) {
    return undefined;
  }
  if (step.durable === false || step.kind === 'schedule') {
    return undefined;
  }
  if (!step.replayKey) {
    return impl.currentPath();
  }
  try {
    return `${REPLAY_KEY_PREFIX}${step.replayKey(input, ctx)}`;
  } catch (error) {
    console.warn(
      `execute: replayKey for step "${step.id}" threw; running it without replay or recording:`,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

/**
 * Resume path: when a previous run recorded this exact step at `ledgerKey`,
 * replay its output instead of re-running, and emit `step_replayed`. Returns
 * `{ hit: false }` when there is nothing to replay so the caller dispatches the
 * step normally.
 */
function replayFromLedger<TContext, I, O>(opts: {
  ledger: StepLedger | undefined;
  ledgerKey: string | undefined;
  step: Step<TContext, I, O>;
  broadcaster: EventBroadcaster | undefined;
  agentName: string;
}):
  | {
      hit: true;
      output: O;
    }
  | {
      hit: false;
    } {
  const { ledger, ledgerKey, step, broadcaster, agentName } = opts;
  if (!ledger || ledgerKey === undefined || ledger.isEmpty) {
    return {
      hit: false,
    };
  }
  const replayed = ledger.take(ledgerKey, {
    id: step.id,
    kind: step.kind,
  });
  if (!replayed) {
    return {
      hit: false,
    };
  }
  emitFrameworkEvent({
    broadcaster,
    agentName,
    eventType: 'step_replayed',
    data: {
      stepId: step.id,
      kind: step.kind,
    },
  });
  return {
    hit: true,
    output: frameworkCast<O>(replayed.output),
  };
}

/**
 * Record a completed step's output so a resumed run replays it rather than
 * re-executing. A no-op without a ledger or ledger key. Only successes reach
 * here — a step that threw skips this call in `execute` and runs again on resume.
 */
async function recordToLedger<TContext, I, O>(opts: {
  ledger: StepLedger | undefined;
  ledgerKey: string | undefined;
  step: Step<TContext, I, O>;
  output: O;
}): Promise<void> {
  const { ledger, ledgerKey, step, output } = opts;
  if (!ledger || ledgerKey === undefined) {
    return;
  }
  await ledger.record({
    path: ledgerKey,
    stepId: step.id,
    kind: step.kind,
    output,
    completedAt: new Date().toISOString(),
  });
}

//#endregion

/**
 * Executes a step within the interpreter, dispatching to the appropriate handler by step kind.
 *
 * @param step - The step to execute.
 * @param input - Input value passed to the step.
 * @param ctx - Execution context carrying state, tokens, and observability.
 * @returns The step's output value.
 * @throws `NoeticError` with kind `step_failed` if max depth is exceeded or an unknown step kind is encountered.
 * @throws `NoeticError` with kind `cancelled` if the context is aborted.
 */
export async function execute<TContext = ContextData, I = unknown, O = unknown>(
  step: Step<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
): Promise<O> {
  const baseCtx = frameworkCast<Context>(ctx);
  // Depth guard — classified as step_failed (not budget_exceeded) because depth
  // is a structural safety limit, not a user-configurable budget field.
  if (ctx.depth >= MAX_DEPTH) {
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: new Error(`Maximum spawn depth ${MAX_DEPTH} exceeded (depth: ${ctx.depth})`),
      retriesExhausted: true,
    });
  }

  // Abort check
  if (ctx.aborted) {
    throw new NoeticErrorImpl({
      kind: 'cancelled',
      reason: ctx.abortReason ?? 'context aborted',
    });
  }

  // Increment step count
  if (isMutableContext(baseCtx)) {
    baseCtx.stepCount = (baseCtx.stepCount || 0) + 1;
  }

  // Emit step_started framework event (respects step.emit option)
  const broadcaster = getBroadcaster(baseCtx);
  const agentName = baseCtx.harness.config.name;
  const startedData = {
    stepId: step.id,
    kind: step.kind,
  };
  const emit = resolveStepEmit(step);
  if (shouldEmit(emit, 'step_started', startedData)) {
    emitFrameworkEvent({
      broadcaster,
      agentName,
      eventType: 'step_started',
      data: startedData,
    });
  }

  /* Register the step as in flight, so a checkpoint records it in the frontier, and
   * run it on its own lane: a view of the context that carries this dispatch's path.
   * Steps this step dispatches hang under that path, so concurrent dispatches on one
   * context cannot interleave each other's paths. Steps with empty ids stay on the
   * caller's lane — they are not reattachable by id and add no path segment. */
  const impl = asContextImpl(baseCtx);
  const frame = {
    stepId: step.id,
    input,
  };
  const lane = impl && step.id.length > 0 ? impl.enterStep(frame) : null;
  const stepCtx = lane ? frameworkCast<Context<TContext>>(lane) : ctx;

  /* Resume: a previous run that completed this exact step replays its recorded
   * output instead of re-running it. `ledgerKey`/`ledger` are captured before
   * dispatch and reused by the record below. */
  const ledgerKey = resolveLedgerKey(step, input, stepCtx);
  const ledger = impl?.ledger;
  const replay = replayFromLedger({
    ledger,
    ledgerKey,
    step,
    broadcaster,
    agentName,
  });
  if (replay.hit) {
    lane?.leaveStep(frame);
    return replay.output;
  }

  let result: O;
  try {
    switch (step.kind) {
      case 'runCode':
        result = await dispatchViaAdapter(step, input, stepCtx, stepCtx.id, () =>
          executeRunCode(step, input, stepCtx),
        );
        break;
      case 'callModel':
        result = await executeCallModel(step, input, stepCtx, baseCtx.layers);
        break;
      case 'acp-agent':
        result = await executeAcpAgent(step, input, stepCtx, baseCtx.layers);
        break;
      case 'invokeTool':
        result = await executeInvokeTool(step, input, stepCtx, baseCtx.harness);
        break;
      case 'decide':
        result = await executeDecide(step, input, stepCtx, baseCtx.layers);
        break;
      case 'conditional':
        result = await executeConditional(step, input, stepCtx, (s, i, c) => execute(s, i, c));
        break;
      case 'inParallel':
        result = await executeInParallel(step, input, stepCtx, (s, i, c) => execute(s, i, c), {
          // Fork paths are child executions: the layer store lets their
          // `onSpawn`/`onReturn` boundary run (see `createForkLayerBridge`).
          layerStore: harnessWithLayerStore(baseCtx).layerStateStore,
          itemSchemas: baseCtx.itemSchemas,
        });
        break;
      case 'spawn': {
        // Allocated here so the adapter request names the child it runs.
        const childId = crypto.randomUUID();
        result = await dispatchViaAdapter(step, input, stepCtx, childId, () =>
          executeSpawn(step, input, stepCtx, (s, i, c) => execute(s, i, c), {
            ...buildSpawnOpts(stepCtx),
            childId,
          }),
        );
        break;
      }
      case 'withContext':
        result = await executeWithContext(step, input, stepCtx, (s, i, c) => execute(s, i, c), {
          layerStore: harnessWithLayerStore(baseCtx).layerStateStore,
          storage: harnessWithLayerStore(baseCtx).config?.storage,
        });
        break;
      case 'loop':
        result = await executeLoop(step, input, stepCtx, (s, i, c) => execute(s, i, c));
        break;
      case 'schedule':
        result = await executeSchedule(step, input, stepCtx, (s, i, c) => execute(s, i, c));
        break;
      default: {
        const _exhaustive: never = step;
        void _exhaustive;
        throw new NoeticErrorImpl({
          kind: 'step_failed',
          stepId: 'unknown',
          cause: new Error('Unknown step kind'),
          retriesExhausted: false,
        });
      }
    }
  } finally {
    lane?.leaveStep(frame);
  }

  // Emit step_completed framework event (respects step.emit option)
  const completedData = {
    stepId: step.id,
    kind: step.kind,
  };
  if (shouldEmit(emit, 'step_completed', completedData)) {
    emitFrameworkEvent({
      broadcaster,
      agentName,
      eventType: 'step_completed',
      data: completedData,
    });
  }

  /* Record the completed step so a resumed run replays this output rather than
   * re-running the step. Only successes are recorded: a step that threw must run
   * again. */
  await recordToLedger({
    ledger,
    ledgerKey,
    step,
    output: result,
  });

  /* Durability boundary (spec 23): snapshot after each completed step, so a crash
   * lands on a checkpoint that includes the item-log and layer-state mutations this
   * step produced. A no-op unless the harness has a CheckpointStore, and a failing
   * save is logged rather than thrown — durability must never fail a good step. */
  await baseCtx.checkpoint();

  return result;
}
