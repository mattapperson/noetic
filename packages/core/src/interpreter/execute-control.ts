/**
 * Control-flow step handlers: conditional, inParallel, loop, every.
 */

import type { ContextData } from '@noetic-tools/context';
import type {
  Channel,
  Context,
  ExecuteStepFn,
  NoeticError,
  SettleResult,
  Snapshot,
  Step,
  StepConditional,
  StepInParallel,
  StepInParallelAll,
  StepInParallelRace,
  StepInParallelSettle,
  StepLoop,
  StepSchedule,
  Verdict,
} from '@noetic-tools/types';
import { createMessage, frameworkCast, isNoeticError, NoeticErrorImpl } from '@noetic-tools/types';
import type { ChannelStore } from '../runtime/channel-store';
import { ContextImpl } from '../runtime/context-impl';
import { snapshotCwdState } from '../runtime/cwd-helpers';
import type { ItemSchemaRegistry, LayerStateStore } from './action-deps';
import { contextToExecCtx, returnLayers, spawnLayers } from './action-deps';
import { cloneWithGuard } from './clone-guard';
import { getContextChannelStore, isContextImpl, isMutableContext } from './typeguards';

//#region conditional

export async function executeConditional<TContext, I, O>(
  step: StepConditional<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
  executeStep: ExecuteStepFn,
): Promise<O> {
  const selected = await step.route(input, ctx);
  if (selected === null) {
    // Requires I assignable to O for null route — when no conditional is selected,
    // the input passes through. Callers must ensure I is compatible with O.
    return frameworkCast<O>(input);
  }
  return executeStep<TContext, I, O>(selected, input, ctx);
}

//#endregion

//#region inParallel

function createChildContexts(ctx: Context, count: number, stepId: string): ContextImpl[] {
  const threadId = isContextImpl(ctx) ? ctx.threadId : crypto.randomUUID();
  const resourceId = isContextImpl(ctx) ? ctx.resourceId : undefined;
  const channelStore = getContextChannelStore(ctx);
  const parentPath = isContextImpl(ctx) ? ctx.currentPath() : '';
  const parentLedger = isContextImpl(ctx) ? ctx.ledger : undefined;

  return Array.from(
    {
      length: count,
    },
    (_unused, index) =>
      new ContextImpl({
        harness: ctx.harness,
        parent: ctx,
        /* Ledger paths must stay unique across sibling paths: a child ContextImpl
         * starts with an empty frontier, so without a prefix every path would
         * restart at the root and collide with its siblings. */
        pathPrefix: `${parentPath}[${index}]`,
        ledger: parentLedger,
        items: [
          ...ctx.itemLog.items,
        ],
        state: cloneWithGuard(ctx.state, `Fork '${stepId}'`),
        threadId,
        resourceId,
        channelStore,
        cwdState: snapshotCwdState(ctx),
        // Layers and the harness tool pool cross the inParallel boundary: without
        // them an `llm` step inside a path would run with no context
        // projection and no layer tools, and a nested `spawn` would have no
        // parent layers to inherit. Per-path layer STATE is still isolated —
        // see `createForkLayerBridge`.
        layers: ctx.layers,
        unifiedTools: ctx.unifiedTools,
      }),
  );
}

/**
 * Runs the context-layer child-boundary lifecycle around each forked path.
 *
 * An inParallel path is a child execution exactly like a spawn child: `onSpawn`
 * seeds its layer state from the parent's, and `onReturn` merges the path's
 * contribution back when it succeeds. Without this, layer state written
 * inside a path is keyed to the path's own execution id and is dropped when
 * the path ends — so `durable-task-state` artifacts recorded by fan-out
 * workers never reached the coordinator.
 *
 * Differences from `executeSpawn`, both deliberate:
 * - `onSpawn` items are NOT appended. An inParallel child already inherits the
 *   parent's full item log; spawn children start empty, which is what those
 *   items exist to seed.
 * - `onReturn` calls are serialised. Paths finish concurrently and each merge
 *   is a read-modify-write of one parent state; unserialised, the last writer
 *   would silently drop its siblings' contributions.
 *
 * Failed paths are not merged (same rule as `spawn`, whose `onReturn` is
 * skipped when the child throws); their layer state is discarded on cleanup.
 */
interface ForkLayerBridge {
  seed(index: number): Promise<void>;
  settle<T>(index: number, result: T): Promise<T>;
  cleanup(index: number): void;
}

function createForkLayerBridge({
  ctx,
  childContexts,
  opts,
}: {
  ctx: Context<ContextData>;
  childContexts: ContextImpl[];
  opts?: ExecuteForkOpts;
}): ForkLayerBridge | null {
  const layers = ctx.layers;
  const layerStore = opts?.layerStore;
  if (!layers || layers.length === 0 || !layerStore) {
    return null;
  }

  const parentExecCtx = contextToExecCtx(ctx);
  const childExecCtxs = childContexts.map((child) => contextToExecCtx(child));
  let tail: Promise<unknown> = Promise.resolve();

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    async seed(index) {
      await spawnLayers({
        layers: layers ?? [],
        parentCtx: parentExecCtx,
        childCtx: childExecCtxs[index],
        store: layerStore,
        itemSchemas: opts?.itemSchemas,
      });
    },
    settle(index, result) {
      return serialize(() =>
        returnLayers({
          layers: layers ?? [],
          parentCtx: parentExecCtx,
          childCtx: childExecCtxs[index],
          childLog: childContexts[index].itemLog,
          result,
          store: layerStore,
        }),
      );
    },
    cleanup(index) {
      layerStore.cleanup(childExecCtxs[index].executionId);
    },
  };
}

/**
 * Wraps the interpreter's `executeStep` so every forked path runs inside the
 * layer child boundary. Contexts that are not one of this inParallel's children
 * (nested steps within a path) pass straight through.
 */
function withForkLayers(
  executeStep: ExecuteStepFn,
  childContexts: ContextImpl[],
  bridge: ForkLayerBridge | null,
): ExecuteStepFn {
  if (!bridge) {
    return executeStep;
  }
  const indexByContext = new Map<Context, number>(
    childContexts.map((child, i) => [
      child,
      i,
    ]),
  );

  return async <TContext, I, O>(
    step: Step<TContext, I, O>,
    input: I,
    childCtx: Context<TContext>,
  ): Promise<O> => {
    const index = indexByContext.get(frameworkCast<Context>(childCtx));
    if (index === undefined) {
      return executeStep<TContext, I, O>(step, input, childCtx);
    }
    await bridge.seed(index);
    try {
      const output = await executeStep<TContext, I, O>(step, input, childCtx);
      return await bridge.settle(index, output);
    } finally {
      bridge.cleanup(index);
    }
  };
}

/** Layer-boundary wiring supplied by the interpreter (see `buildSpawnOpts`). */
export interface ExecuteForkOpts {
  layerStore?: LayerStateStore;
  itemSchemas?: ItemSchemaRegistry;
}

export async function executeInParallel<TContext, I, O>(
  step: StepInParallel<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
  rawExecuteStep: ExecuteStepFn,
  opts?: ExecuteForkOpts,
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextData>>(ctx);
  const paths = step.paths(input, ctx);

  if (paths.length === 0) {
    if (step.mode === 'all') {
      return step.merge([], ctx);
    }
    if (step.mode === 'settle') {
      return step.merge([], ctx);
    }
    throw new NoeticErrorImpl({
      kind: 'fork_partial',
      stepId: step.id,
      succeeded: [],
      failed: [],
    });
  }

  const childContexts = createChildContexts(baseCtx, paths.length, step.id);
  const concurrency = step.concurrency ?? paths.length;
  const executeStep = withForkLayers(
    rawExecuteStep,
    childContexts,
    createForkLayerBridge({
      ctx: baseCtx,
      childContexts,
      opts,
    }),
  );

  try {
    switch (step.mode) {
      case 'all':
        return await executeAll(step, paths, input, ctx, childContexts, executeStep, concurrency);
      case 'race':
        return await executeRace(step, paths, input, ctx, childContexts, executeStep, concurrency);
      case 'settle':
        return await executeSettle(
          step,
          paths,
          input,
          ctx,
          childContexts,
          executeStep,
          concurrency,
        );
      default: {
        const _exhaustive: never = step;
        throw new NoeticErrorImpl({
          kind: 'step_failed',
          stepId: 'unknown',
          cause: new Error('Unknown inParallel mode'),
          retriesExhausted: false,
        });
      }
    }
  } finally {
    // Every path has settled (or been abandoned in `race`): leave the parent's
    // abort cascade so it retains only children that are still cancellable.
    for (const child of childContexts) {
      child.detachFromParent();
    }
  }
}

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      try {
        const value = await tasks[index]();
        results[index] = {
          status: 'fulfilled',
          value,
        };
      } catch (reason) {
        results[index] = {
          status: 'rejected',
          reason,
        };
      }
    }
  }

  const workers = Array.from(
    {
      length: Math.min(concurrency, tasks.length),
    },
    () => runNext(),
  );
  await Promise.all(workers);
  return results;
}

interface StepResult<T> {
  stepId: string;
  value: T;
}
interface StepError {
  stepId: string;
  error: NoeticError;
}

function toNoeticError(err: unknown, stepId: string): NoeticError {
  if (isNoeticError(err)) {
    return err.noeticError;
  }
  return {
    kind: 'step_failed',
    stepId,
    cause: err instanceof Error ? err : new Error(String(err)),
    retriesExhausted: false,
  };
}

function classifyResults<T>(
  settled: PromiseSettledResult<T>[],
  paths: {
    id: string;
  }[],
): {
  succeeded: StepResult<T>[];
  failed: StepError[];
} {
  const succeeded: StepResult<T>[] = [];
  const failed: StepError[] = [];

  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      succeeded.push({
        stepId: paths[i].id,
        value: result.value,
      });
    } else {
      failed.push({
        stepId: paths[i].id,
        error: toNoeticError(result.reason, paths[i].id),
      });
    }
  });

  return {
    succeeded,
    failed,
  };
}

async function executeAll<TContext, I, O>(
  step: StepInParallelAll<TContext, I, O>,
  paths: Step<TContext, I, O>[],
  _input: I,
  ctx: Context<TContext>,
  childContexts: ContextImpl[],
  executeStep: ExecuteStepFn,
  concurrency: number,
): Promise<O> {
  // Fail-fast (specs 03/09): the first genuine path failure aborts every
  // sibling child context. Cancellation is cooperative — in-flight siblings
  // are still awaited (they stop at their next step boundary / blocked
  // channel op) so fork_partial's succeeded/failed stay accurate; paths
  // still queued behind the concurrency limit are skipped outright. Skipped
  // and aborted paths appear in `failed` with kind 'cancelled'.
  let firstFailureSeen = false;

  const tasks = paths.map((path, i) => async (): Promise<O> => {
    if (firstFailureSeen) {
      throw new NoeticErrorImpl({
        kind: 'cancelled',
        reason: `inParallel '${step.id}' sibling failed`,
      });
    }
    try {
      return await executeStep<TContext, I, O>(
        path,
        _input,
        frameworkCast<Context<TContext>>(childContexts[i]),
      );
    } catch (e) {
      const isCancellation = isNoeticError(e) && e.noeticError.kind === 'cancelled';
      if (!isCancellation && !firstFailureSeen) {
        firstFailureSeen = true;
        for (let j = 0; j < childContexts.length; j++) {
          if (j !== i) {
            childContexts[j].abort(`inParallel '${step.id}' sibling failed`);
          }
        }
      }
      throw e;
    }
  });
  const settled = await runWithConcurrency(tasks, concurrency);
  const { succeeded, failed } = classifyResults(settled, paths);

  // If the PARENT context was aborted mid-inParallel, the whole inParallel is cancelled —
  // surface 'cancelled', not a partial-failure shape (spec 09, item 3).
  if (ctx.aborted) {
    throw new NoeticErrorImpl({
      kind: 'cancelled',
      reason: ctx.abortReason ?? 'context aborted',
    });
  }

  if (failed.length > 0) {
    throw new NoeticErrorImpl({
      kind: 'fork_partial',
      stepId: step.id,
      succeeded,
      failed,
    });
  }

  const results: O[] = succeeded.map((s) => s.value);
  return step.merge(results, ctx);
}

async function executeRace<TContext, I, O>(
  step: StepInParallelRace<TContext, I, O>,
  paths: Step<TContext, I, O>[],
  input: I,
  ctx: Context<TContext>,
  childContexts: ContextImpl[],
  executeStep: ExecuteStepFn,
  concurrency: number,
): Promise<O> {
  const raceBaseCtx = frameworkCast<Context<ContextData>>(ctx);
  return new Promise<O>((resolve, reject) => {
    let settled = false;
    let failedCount = 0;
    let nextIndex = 0;
    const errors: StepError[] = [];
    const totalPaths = paths.length;

    function startNext(): void {
      if (settled || nextIndex >= totalPaths) {
        return;
      }
      const i = nextIndex++;

      executeStep<TContext, I, O>(
        paths[i],
        input,
        frameworkCast<Context<TContext>>(childContexts[i]),
      )
        .then((result) => {
          if (settled) {
            return;
          }
          settled = true;
          // Winner's state replaces parent's
          if (isContextImpl(raceBaseCtx)) {
            raceBaseCtx.state = childContexts[i].state;
          }
          // Resolve first, then abort losers (non-critical path)
          resolve(result);
          for (let j = 0; j < childContexts.length; j++) {
            if (j !== i) {
              childContexts[j].abort('race lost');
            }
          }
        })
        .catch((err: unknown) => {
          failedCount++;
          errors.push({
            stepId: paths[i].id,
            error: toNoeticError(err, paths[i].id),
          });

          // Start next task if available
          if (!settled) {
            startNext();
          }

          if (failedCount === totalPaths && !settled) {
            settled = true;
            reject(
              new NoeticErrorImpl({
                kind: 'fork_partial',
                stepId: step.id,
                succeeded: [],
                failed: errors,
              }),
            );
          }
        });
    }

    // Launch initial batch respecting concurrency
    const initialBatch = Math.min(concurrency, totalPaths);
    for (let i = 0; i < initialBatch; i++) {
      startNext();
    }
  });
}

async function executeSettle<TContext, I, O>(
  step: StepInParallelSettle<TContext, I, O>,
  paths: Step<TContext, I, O>[],
  input: I,
  ctx: Context<TContext>,
  childContexts: ContextImpl[],
  executeStep: ExecuteStepFn,
  concurrency: number,
): Promise<O> {
  const tasks = paths.map(
    (path, i) => () =>
      executeStep<TContext, I, O>(path, input, frameworkCast<Context<TContext>>(childContexts[i])),
  );
  const settled = await runWithConcurrency(tasks, concurrency);

  // Parent aborted mid-inParallel: the inParallel is cancelled, merge never runs
  // (spec 09, Cancellation item 3 — same rule as mode 'all').
  if (ctx.aborted) {
    throw new NoeticErrorImpl({
      kind: 'cancelled',
      reason: ctx.abortReason ?? 'context aborted',
    });
  }

  const results: SettleResult<O>[] = settled.map((result, i) => {
    if (result.status === 'fulfilled') {
      return {
        stepId: paths[i].id,
        status: 'fulfilled' as const,
        value: result.value,
      };
    }
    return {
      stepId: paths[i].id,
      status: 'rejected' as const,
      error: toNoeticError(result.reason, paths[i].id),
    };
  });

  return step.merge(results, ctx);
}

//#endregion

//#region loop

type InboxFields = Pick<StepLoop<unknown, unknown, unknown>, 'inbox' | 'parkTimeout'>;

function hasTextField(value: unknown): value is {
  text: unknown;
} {
  return typeof value === 'object' && value !== null && 'text' in value;
}

async function recvInboxWithTimeout(ctx: Context, step: InboxFields): Promise<string | null> {
  if (!step.inbox) {
    return null;
  }
  if ((step.parkTimeout ?? 0) <= 0) {
    return ctx.tryRecv(step.inbox);
  }
  try {
    return await ctx.recv(step.inbox, {
      timeout: step.parkTimeout,
    });
  } catch (e) {
    // Cancellation must terminate the loop, not read as "no message".
    if (isNoeticError(e) && e.noeticError.kind === 'cancelled') {
      throw e;
    }
    // Expected: channel_timeout error when parkTimeout expires with no message.
    return null;
  }
}

function prepareNextInput<TContext, I, O>(
  step: StepLoop<TContext, I, O>,
  lastOutput: O,
  verdict: Verdict,
  ctx: Context<TContext>,
): I {
  if (step.prepareNext) {
    return step.prepareNext(lastOutput, verdict, ctx);
  }
  // Requires I === O when prepareNext is omitted — the loop feeds output
  // back as input. Callers must ensure I and O are compatible types.
  return frameworkCast<I>(lastOutput);
}

export async function executeLoop<TContext, I, O>(
  step: StepLoop<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
  executeStep: ExecuteStepFn,
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextData>>(ctx);
  let currentInput: I = input;
  let lastOutput: O | undefined;
  let lastText = '';
  const history: unknown[] = [];
  const startTime = Date.now();
  let stepCount = 0;
  const maxIterations = step.maxIterations ?? 1e3;
  const maxHistory = step.maxHistorySize ?? 100;
  let totalIterations = 0;

  // Validate maxIterations
  if (!Number.isFinite(maxIterations) || maxIterations < 1) {
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: new Error(`Invalid maxIterations: ${step.maxIterations}`),
      retriesExhausted: false,
    });
  }

  while (true) {
    // Abort check at top of each iteration
    if (ctx.aborted) {
      throw new NoeticErrorImpl({
        kind: 'cancelled',
        reason: ctx.abortReason ?? 'context aborted',
      });
    }

    // Enforce hard iteration ceiling (includes retries)
    totalIterations++;
    if (totalIterations > maxIterations) {
      throw new NoeticErrorImpl({
        kind: 'step_failed',
        stepId: step.id,
        cause: new Error(`Loop exceeded maximum iterations (${maxIterations})`),
        retriesExhausted: false,
      });
    }

    // Execute body steps sequentially
    let output: O;
    try {
      let stepOutput: unknown = currentInput;
      for (const bodyStep of step.steps) {
        stepOutput = await executeStep(bodyStep, frameworkCast(stepOutput), ctx);
      }
      output = frameworkCast<O>(stepOutput);
      stepCount++;
    } catch (e) {
      if (!step.onError || !isNoeticError(e)) {
        throw e;
      }
      // Cancellation is not a retriable error (spec 09): it must terminate
      // the loop promptly rather than be consumed by 'retry'/'skip'. Same
      // guard as executeSchedule's 'continue' policy below.
      if (e.noeticError.kind === 'cancelled') {
        throw e;
      }
      const action = step.onError(e.noeticError, ctx);
      if (action === 'retry') {
        continue;
      }
      if (action !== 'skip') {
        throw e;
      }
      // Skip does not increment stepCount — it is not a successful execution.
      if (lastOutput === undefined) {
        continue;
      }
      output = lastOutput;
    }

    lastOutput = output;
    history.push(output);

    // Trim history if it exceeds maxHistorySize
    if (history.length > maxHistory) {
      history.splice(0, history.length - maxHistory);
    }

    // Extract text from output for snapshot
    if (typeof output === 'string') {
      lastText = output;
    } else if (hasTextField(output)) {
      lastText = String(output.text);
    } else {
      lastText = output === undefined ? '' : JSON.stringify(output);
    }

    // Build snapshot
    const snapshot: Snapshot = {
      stepCount,
      tokens: {
        ...ctx.tokens,
      },
      elapsed: Date.now() - startTime,
      cost: ctx.cost,
      lastOutput: output,
      lastText,
      history: [
        ...history,
      ],
      depth: ctx.depth,
      lastStepMeta: isMutableContext(baseCtx) ? baseCtx.lastStepMeta : null,
    };

    // Evaluate until predicate
    let verdict: Verdict;
    try {
      verdict = await step.until(snapshot);
    } catch (predicateError) {
      // Per spec: if until predicate throws, treat as stop
      verdict = {
        stop: true,
        reason: `Predicate error: ${predicateError instanceof Error ? predicateError.message : String(predicateError)}`,
      };
    }

    if (verdict.stop) {
      if (lastOutput === undefined) {
        throw new NoeticErrorImpl({
          kind: 'step_failed',
          stepId: step.id,
          cause: new Error('Loop completed with no successful output'),
          retriesExhausted: false,
        });
      }

      // Check inbox before truly stopping
      if (step.inbox) {
        const inboxMessage = await recvInboxWithTimeout(baseCtx, step);
        if (inboxMessage !== null) {
          baseCtx.itemLog.append(createMessage(inboxMessage, 'developer'));
          // Continue the loop — don't stop
          currentInput = prepareNextInput(step, lastOutput, verdict, ctx);
          continue;
        }
      }

      return lastOutput;
    }

    // Prepare input for next iteration
    currentInput = prepareNextInput(step, output, verdict, ctx);
  }
}

//#endregion

//#region every

interface ParkContext<TContext> {
  ms: number;
  jitter: number;
  inbox?: Channel<unknown>;
  ctx: Context<TContext>;
  channelStore?: ChannelStore;
}

/** Returns the next park duration in ms, applying random jitter clamped to `[ms - jitter, ms + jitter]`. */
function nextParkMs(ms: number, jitter: number): number {
  if (jitter <= 0) {
    return ms;
  }
  // Math.random() returns [0, 1); shift to [-1, 1) so jitter is symmetric.
  const offset = (Math.random() * 2 - 1) * jitter;
  const value = ms + offset;
  if (value < 0) {
    return 0;
  }
  return value;
}

/**
 * Parks for `ms` ms, returning early if `inbox` receives a message or the
 * context is aborted. Always resolves; never throws (cancellation surfaces on
 * the next iteration's abort check).
 */
function park<TContext>(parkCtx: ParkContext<TContext>): Promise<void> {
  const duration = nextParkMs(parkCtx.ms, parkCtx.jitter);

  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abortPoll: ReturnType<typeof setInterval> | null = null;
    let wakeUnsub: (() => void) | null = null;

    const settle = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (abortPoll !== null) {
        clearInterval(abortPoll);
      }
      if (wakeUnsub !== null) {
        wakeUnsub();
      }
      resolve();
    };

    timer = setTimeout(settle, duration);

    // Poll the abort flag at a coarse interval to wake parking when the
    // context is aborted. The Context interface exposes only `aborted` as a
    // boolean, so this is the simplest interruption strategy that respects
    // the public contract.
    abortPoll = setInterval(() => {
      if (parkCtx.ctx.aborted) {
        settle();
      }
    }, 5);

    if (!parkCtx.inbox) {
      return;
    }
    const { channelStore } = parkCtx;
    if (channelStore) {
      // Non-consuming subscription so the body still observes the message that
      // woke us — `recv()` would dequeue queue-mode messages and leave the
      // body's drain loop empty.
      wakeUnsub = channelStore.subscribeWake(parkCtx.inbox, settle);
      return;
    }
    // Contexts without a ContextImpl/channel store have no body draining the
    // channel anyway; the destructive `recv` is acceptable in that edge case.
    parkCtx.ctx
      .recv(parkCtx.inbox, {
        timeout: Math.max(duration, 1) + 1e2,
      })
      .then(settle)
      .catch(() => {
        // Channel timeout / store error — another path settles us.
      });
  });
}

function recordIterationError<TContext>(ctx: Context<TContext>, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? error.stack : '';
  ctx.span.addEvent('every.iteration.error', {
    message,
    stack,
  });
}

function throwCancelled(reason: string | undefined): never {
  throw new NoeticErrorImpl({
    kind: 'cancelled',
    reason: reason ?? 'context aborted',
  });
}

/**
 * Executes an `every` step: runs the body step forever, paced by `ms ± jitter`,
 * woken early by `inbox`. Throws `cancelled` when the context is aborted.
 *
 * On body throw, behavior depends on `onError`:
 * - `'continue'` (default): emit `every.iteration.error` span event and proceed
 *   to the park step as if no error occurred.
 * - `'fail'`: re-throw, terminating the operator.
 *
 * The body's output is discarded — `every` runs forever and does not accumulate
 * iteration outputs. Only ever returns by throwing on cancellation or `fail`.
 */
export async function executeSchedule<TContext, I, O>(
  step: StepSchedule<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
  executeStep: ExecuteStepFn,
): Promise<O> {
  const onError = step.onError ?? 'continue';
  const jitter = step.jitter ?? 0;
  // Resolve once — the channel store reference is stable for the lifetime
  // of the every loop, no need to re-derive it per park.
  const channelStore = getContextChannelStore(ctx);

  while (true) {
    if (ctx.aborted) {
      throwCancelled(ctx.abortReason);
    }

    try {
      await executeStep(step.step, input, ctx);
    } catch (e) {
      if (onError === 'fail') {
        throw e;
      }
      // 'continue' policy — but a cancellation should still terminate the
      // operator promptly rather than be swallowed and re-parked.
      if (isNoeticError(e) && e.noeticError.kind === 'cancelled') {
        throw e;
      }
      recordIterationError(ctx, e);
    }

    if (ctx.aborted) {
      throwCancelled(ctx.abortReason);
    }

    await park({
      ms: step.interval,
      jitter,
      inbox: step.inbox,
      ctx,
      channelStore,
    });
  }
}

//#endregion
