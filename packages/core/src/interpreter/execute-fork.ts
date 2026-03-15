import type { Step, StepFork, StepForkAll, StepForkRace, StepForkSettle, SettleResult } from '../types/step';
import type { Context } from '../types/context';
import type { OrchidError } from '../types/error';
import { ContextImpl } from '../runtime/context-impl';
import { OrchidErrorImpl, isOrchidError } from '../errors/orchid-error';
import { isContextImpl } from './typeguards';

export type ExecuteStepFn = <I, O>(step: Step<I, O>, input: I, ctx: Context) => Promise<O>;

const LARGE_STATE_THRESHOLD = 10 * 1024 * 1024; // 10MB

// Note: Returns 0 for non-JSON-serializable state (Maps, Sets, circular refs).
// The warning will not fire for those cases, but structuredClone will still handle them.
function estimateSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function createChildContexts(ctx: Context, count: number, stepId: string): ContextImpl[] {
  // Warn if state is large before cloning
  const stateSize = estimateSize(ctx.state);
  if (stateSize > LARGE_STATE_THRESHOLD) {
    console.warn(
      `[orchid] Fork '${stepId}': state size (~${Math.round(stateSize / 1024 / 1024)}MB) exceeds 10MB threshold. ` +
      `Consider reducing state size before forking to avoid performance issues.`,
    );
  }

  const threadId = isContextImpl(ctx) ? ctx.threadId : crypto.randomUUID();
  const resourceId = isContextImpl(ctx) ? ctx.resourceId : undefined;

  return Array.from({ length: count }, () =>
    new ContextImpl({
      parent: ctx,
      items: [...ctx.itemLog.items],
      state: structuredClone(ctx.state),
      threadId,
      resourceId,
    }),
  );
}

export async function executeFork<I, O>(
  step: StepFork<I, O>,
  input: I,
  ctx: Context,
  executeStep: ExecuteStepFn,
): Promise<O> {
  const paths = step.paths(input, ctx);

  if (paths.length === 0) {
    if (step.mode === 'all') {
      return step.merge([], ctx);
    } else if (step.mode === 'settle') {
      return step.merge([], ctx);
    }
    throw new OrchidErrorImpl({
      kind: 'fork_partial',
      stepId: step.id,
      succeeded: [],
      failed: [],
    });
  }

  const childContexts = createChildContexts(ctx, paths.length, step.id);
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
      throw new OrchidErrorImpl({
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
        results[index] = { status: 'fulfilled', value };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

interface StepResult<T> { stepId: string; value: T }
interface StepError { stepId: string; error: OrchidError }

function toOrchidError(err: unknown, stepId: string): OrchidError {
  if (isOrchidError(err)) return err.orchidError;
  return {
    kind: 'step_failed',
    stepId,
    cause: err instanceof Error ? err : new Error(String(err)),
    retriesExhausted: false,
  };
}

function classifyResults<T>(settled: PromiseSettledResult<T>[], paths: { id: string }[]): { succeeded: StepResult<T>[]; failed: StepError[] } {
  const succeeded: StepResult<T>[] = [];
  const failed: StepError[] = [];

  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      succeeded.push({ stepId: paths[i].id, value: result.value });
    } else {
      failed.push({ stepId: paths[i].id, error: toOrchidError(result.reason, paths[i].id) });
    }
  });

  return { succeeded, failed };
}

async function executeAll<I, O>(
  step: StepForkAll<I, O>,
  paths: Step<I, O>[],
  _input: I,
  ctx: Context,
  childContexts: ContextImpl[],
  executeStep: ExecuteStepFn,
  concurrency: number,
): Promise<O> {
  const tasks = paths.map((path, i) => () => executeStep<I, O>(path, _input, childContexts[i]));
  const settled = await runWithConcurrency(tasks, concurrency);
  const { succeeded, failed } = classifyResults(settled, paths);

  if (failed.length > 0) {
    throw new OrchidErrorImpl({
      kind: 'fork_partial',
      stepId: step.id,
      succeeded,
      failed,
    });
  }

  const results: O[] = succeeded.map(s => s.value);
  return step.merge(results, ctx);
}

async function executeRace<I, O>(
  step: StepForkRace<I, O>,
  paths: Step<I, O>[],
  input: I,
  ctx: Context,
  childContexts: ContextImpl[],
  executeStep: ExecuteStepFn,
  concurrency: number,
): Promise<O> {
  return new Promise<O>((resolve, reject) => {
    let settled = false;
    let failedCount = 0;
    let nextIndex = 0;
    const errors: StepError[] = [];
    const totalPaths = paths.length;

    function startNext(): void {
      if (settled || nextIndex >= totalPaths) return;
      const i = nextIndex++;

      executeStep<I, O>(paths[i], input, childContexts[i])
        .then((result) => {
          if (!settled) {
            settled = true;
            // Winner's state replaces parent's
            if (isContextImpl(ctx)) {
              ctx.state = childContexts[i].state;
            }
            // Abort all other child contexts
            for (let j = 0; j < childContexts.length; j++) {
              if (j !== i) {
                childContexts[j].abort('race lost');
              }
            }
            resolve(result);
          }
        })
        .catch((err: unknown) => {
          failedCount++;
          errors.push({ stepId: paths[i].id, error: toOrchidError(err, paths[i].id) });

          // Start next task if available
          if (!settled) {
            startNext();
          }

          if (failedCount === totalPaths && !settled) {
            settled = true;
            reject(new OrchidErrorImpl({
              kind: 'fork_partial',
              stepId: step.id,
              succeeded: [],
              failed: errors,
            }));
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

async function executeSettle<I, O>(
  step: StepForkSettle<I, O>,
  paths: Step<I, O>[],
  input: I,
  _ctx: Context,
  childContexts: ContextImpl[],
  executeStep: ExecuteStepFn,
  concurrency: number,
): Promise<O> {
  const tasks = paths.map((path, i) => () => executeStep<I, O>(path, input, childContexts[i]));
  const settled = await runWithConcurrency(tasks, concurrency);

  const results: SettleResult<O>[] = settled.map((result, i) => {
    if (result.status === 'fulfilled') {
      return {
        stepId: paths[i].id,
        status: 'fulfilled' as const,
        value: result.value,
      };
    } else {
      return {
        stepId: paths[i].id,
        status: 'rejected' as const,
        error: toOrchidError(result.reason, paths[i].id),
      };
    }
  });

  return step.merge(results, _ctx);
}
