import type { StepFork, SettleResult } from '../types/step';
import type { Context } from '../types/context';
import { ContextImpl } from '../runtime/context-impl';
import { OrchidErrorImpl, isOrchidError } from '../errors/orchid-error';

export type ExecuteStepFn = <I, O>(step: any, input: I, ctx: Context) => Promise<O>;

export async function executeFork<I, O>(
  step: StepFork<I, O>,
  input: I,
  ctx: Context,
  executeStep: ExecuteStepFn,
): Promise<O> {
  const paths = step.paths(input, ctx);

  if (paths.length === 0) {
    if (step.mode === 'all') {
      return (step as any).merge([], ctx);
    } else if (step.mode === 'settle') {
      return (step as any).merge([], ctx);
    }
    throw new OrchidErrorImpl({
      kind: 'fork_partial',
      stepId: step.id,
      succeeded: [],
      failed: [],
    });
  }

  // Create child contexts with deep-cloned state for isolation
  const childContexts = paths.map(() => {
    return new ContextImpl({
      parent: ctx,
      items: [...ctx.itemLog.items],
      state: structuredClone(ctx.state),
      threadId: (ctx as any).threadId,
      resourceId: (ctx as any).resourceId,
    });
  });

  const concurrency = step.concurrency ?? paths.length;

  switch (step.mode) {
    case 'all':
      return executeAll(step, paths, input, ctx, childContexts, executeStep, concurrency);
    case 'race':
      return executeRace(step, paths, input, ctx, childContexts, executeStep, concurrency);
    case 'settle':
      return executeSettle(step, paths, input, ctx, childContexts, executeStep, concurrency);
    default:
      throw new Error(`Unknown fork mode: ${(step as any).mode}`);
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

async function executeAll<I, O>(
  step: StepFork<I, O>,
  paths: any[],
  _input: I,
  ctx: Context,
  childContexts: Context[],
  executeStep: ExecuteStepFn,
  concurrency: number,
): Promise<O> {
  const tasks = paths.map((path, i) => () => executeStep<I, O>(path, _input, childContexts[i]));

  const settled = await runWithConcurrency(tasks, concurrency);

  const succeeded: { stepId: string; value: unknown }[] = [];
  const failed: { stepId: string; error: any }[] = [];

  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      succeeded.push({ stepId: paths[i].id, value: result.value });
    } else {
      const err = result.reason;
      failed.push({
        stepId: paths[i].id,
        error: isOrchidError(err) ? err.orchidError : {
          kind: 'step_failed',
          stepId: paths[i].id,
          cause: err instanceof Error ? err : new Error(String(err)),
          retriesExhausted: false,
        },
      });
    }
  });

  if (failed.length > 0) {
    throw new OrchidErrorImpl({
      kind: 'fork_partial',
      stepId: step.id,
      succeeded,
      failed,
    });
  }

  const results = succeeded.map(s => s.value as O);
  return (step as any).merge(results, ctx);
}

async function executeRace<I, O>(
  step: StepFork<I, O>,
  paths: any[],
  input: I,
  ctx: Context,
  childContexts: Context[],
  executeStep: ExecuteStepFn,
  _concurrency: number,
): Promise<O> {
  return new Promise<O>((resolve, reject) => {
    let settled = false;
    let completedCount = 0;
    const errors: { stepId: string; error: any }[] = [];
    const totalPaths = paths.length;

    paths.forEach((path, i) => {
      executeStep<I, O>(path, input, childContexts[i])
        .then((result) => {
          if (!settled) {
            settled = true;
            // Winner's state replaces parent's
            (ctx as any).state = childContexts[i].state;
            resolve(result);
          }
        })
        .catch((err) => {
          completedCount++;
          errors.push({
            stepId: path.id,
            error: isOrchidError(err) ? err.orchidError : {
              kind: 'step_failed',
              stepId: path.id,
              cause: err instanceof Error ? err : new Error(String(err)),
              retriesExhausted: false,
            },
          });
          if (completedCount === totalPaths && !settled) {
            settled = true;
            reject(new OrchidErrorImpl({
              kind: 'fork_partial',
              stepId: step.id,
              succeeded: [],
              failed: errors,
            }));
          }
        });
    });
  });
}

async function executeSettle<I, O>(
  step: StepFork<I, O>,
  paths: any[],
  input: I,
  ctx: Context,
  childContexts: Context[],
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
      const err = result.reason;
      return {
        stepId: paths[i].id,
        status: 'rejected' as const,
        error: isOrchidError(err) ? err.orchidError : {
          kind: 'step_failed' as const,
          stepId: paths[i].id,
          cause: err instanceof Error ? err : new Error(String(err)),
          retriesExhausted: false,
        },
      };
    }
  });

  return (step as any).merge(results, ctx);
}
