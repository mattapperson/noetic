/**
 * Control-flow step handlers: branch, fork, loop, every.
 */

import type { ContextMemory } from '@noetic-tools/memory';
import type {
  Channel,
  Context,
  ExecuteStepFn,
  NoeticError,
  SettleResult,
  Snapshot,
  Step,
  StepBranch,
  StepEvery,
  StepFork,
  StepForkAll,
  StepForkRace,
  StepForkSettle,
  StepLoop,
  Verdict,
} from '@noetic-tools/types';
import { createMessage, frameworkCast, isNoeticError, NoeticErrorImpl } from '@noetic-tools/types';
import type { ChannelStore } from '../runtime/channel-store';
import { ContextImpl } from '../runtime/context-impl';
import { snapshotCwdState } from '../runtime/cwd-helpers';
import { cloneWithGuard } from './clone-guard';
import { getContextChannelStore, isContextImpl, isMutableContext } from './typeguards';

//#region branch

export async function executeBranch<TMemory, I, O>(
  step: StepBranch<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  executeStep: ExecuteStepFn,
): Promise<O> {
  const selected = await step.route(input, ctx);
  if (selected === null) {
    // Requires I assignable to O for null route — when no branch is selected,
    // the input passes through. Callers must ensure I is compatible with O.
    return frameworkCast<O>(input);
  }
  return executeStep<TMemory, I, O>(selected, input, ctx);
}

//#endregion

//#region fork

function createChildContexts(ctx: Context, count: number, stepId: string): ContextImpl[] {
  const threadId = isContextImpl(ctx) ? ctx.threadId : crypto.randomUUID();
  const resourceId = isContextImpl(ctx) ? ctx.resourceId : undefined;
  const channelStore = getContextChannelStore(ctx);

  return Array.from(
    {
      length: count,
    },
    () =>
      new ContextImpl({
        harness: ctx.harness,
        parent: ctx,
        items: [
          ...ctx.itemLog.items,
        ],
        state: cloneWithGuard(ctx.state, `Fork '${stepId}'`),
        threadId,
        resourceId,
        channelStore,
        cwdState: snapshotCwdState(ctx),
      }),
  );
}

export async function executeFork<TMemory, I, O>(
  step: StepFork<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  executeStep: ExecuteStepFn,
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextMemory>>(ctx);
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

  switch (step.mode) {
    case 'all':
      return executeAll(step, paths, input, ctx, childContexts, executeStep, concurrency);
    case 'race':
      return executeRace(step, paths, input, ctx, childContexts, executeStep, concurrency);
    case 'settle':
      return executeSettle(step, paths, input, ctx, childContexts, executeStep, concurrency);
    default: {
      const _exhaustive: never = step;
      throw new NoeticErrorImpl({
        kind: 'step_failed',
        stepId: 'unknown',
        cause: new Error('Unknown fork mode'),
        retriesExhausted: false,
      });
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

async function executeAll<TMemory, I, O>(
  step: StepForkAll<TMemory, I, O>,
  paths: Step<TMemory, I, O>[],
  _input: I,
  ctx: Context<TMemory>,
  childContexts: ContextImpl[],
  executeStep: ExecuteStepFn,
  concurrency: number,
): Promise<O> {
  const tasks = paths.map(
    (path, i) => () =>
      executeStep<TMemory, I, O>(path, _input, frameworkCast<Context<TMemory>>(childContexts[i])),
  );
  const settled = await runWithConcurrency(tasks, concurrency);
  const { succeeded, failed } = classifyResults(settled, paths);

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

async function executeRace<TMemory, I, O>(
  step: StepForkRace<TMemory, I, O>,
  paths: Step<TMemory, I, O>[],
  input: I,
  ctx: Context<TMemory>,
  childContexts: ContextImpl[],
  executeStep: ExecuteStepFn,
  concurrency: number,
): Promise<O> {
  const raceBaseCtx = frameworkCast<Context<ContextMemory>>(ctx);
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

      executeStep<TMemory, I, O>(paths[i], input, frameworkCast<Context<TMemory>>(childContexts[i]))
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

async function executeSettle<TMemory, I, O>(
  step: StepForkSettle<TMemory, I, O>,
  paths: Step<TMemory, I, O>[],
  input: I,
  _ctx: Context<TMemory>,
  childContexts: ContextImpl[],
  executeStep: ExecuteStepFn,
  concurrency: number,
): Promise<O> {
  const tasks = paths.map(
    (path, i) => () =>
      executeStep<TMemory, I, O>(path, input, frameworkCast<Context<TMemory>>(childContexts[i])),
  );
  const settled = await runWithConcurrency(tasks, concurrency);

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

  return step.merge(results, _ctx);
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
  } catch {
    // Expected: channel_timeout error when parkTimeout expires with no message.
    return null;
  }
}

function prepareNextInput<TMemory, I, O>(
  step: StepLoop<TMemory, I, O>,
  lastOutput: O,
  verdict: Verdict,
  ctx: Context<TMemory>,
): I {
  if (step.prepareNext) {
    return step.prepareNext(lastOutput, verdict, ctx);
  }
  // Requires I === O when prepareNext is omitted — the loop feeds output
  // back as input. Callers must ensure I and O are compatible types.
  return frameworkCast<I>(lastOutput);
}

export async function executeLoop<TMemory, I, O>(
  step: StepLoop<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  executeStep: ExecuteStepFn,
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextMemory>>(ctx);
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

interface ParkContext<TMemory> {
  ms: number;
  jitter: number;
  wakeOn?: Channel<unknown>;
  ctx: Context<TMemory>;
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
 * Parks for `ms` ms, returning early if `wakeOn` receives a message or the
 * context is aborted. Always resolves; never throws (cancellation surfaces on
 * the next iteration's abort check).
 */
function park<TMemory>(parkCtx: ParkContext<TMemory>): Promise<void> {
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

    if (!parkCtx.wakeOn) {
      return;
    }
    const { channelStore } = parkCtx;
    if (channelStore) {
      // Non-consuming subscription so the body still observes the message that
      // woke us — `recv()` would dequeue queue-mode messages and leave the
      // body's drain loop empty.
      wakeUnsub = channelStore.subscribeWake(parkCtx.wakeOn, settle);
      return;
    }
    // Contexts without a ContextImpl/channel store have no body draining the
    // channel anyway; the destructive `recv` is acceptable in that edge case.
    parkCtx.ctx
      .recv(parkCtx.wakeOn, {
        timeout: Math.max(duration, 1) + 1e2,
      })
      .then(settle)
      .catch(() => {
        // Channel timeout / store error — another path settles us.
      });
  });
}

function recordIterationError<TMemory>(ctx: Context<TMemory>, error: unknown): void {
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
 * woken early by `wakeOn`. Throws `cancelled` when the context is aborted.
 *
 * On body throw, behavior depends on `onError`:
 * - `'continue'` (default): emit `every.iteration.error` span event and proceed
 *   to the park step as if no error occurred.
 * - `'fail'`: re-throw, terminating the operator.
 *
 * The body's output is discarded — `every` runs forever and does not accumulate
 * iteration outputs. Only ever returns by throwing on cancellation or `fail`.
 */
export async function executeEvery<TMemory, I, O>(
  step: StepEvery<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
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
      ms: step.ms,
      jitter,
      wakeOn: step.wakeOn,
      ctx,
      channelStore,
    });
  }
}

//#endregion
