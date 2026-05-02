import { isNoeticError, NoeticErrorImpl } from '../errors/noetic-error';
import { ContextImpl } from '../runtime/context-impl';
import { snapshotCwdState } from '../runtime/cwd-helpers';
import type { Context } from '../types/context';
import type { NoeticError } from '../types/error';
import type { ContextMemory } from '../types/memory';
import type {
  ExecuteStepFn,
  SettleResult,
  Step,
  StepFork,
  StepForkAll,
  StepForkRace,
  StepForkSettle,
} from '../types/step';
import { cloneWithGuard } from './clone-guard';
import { frameworkCast } from './framework-cast';
import { getContextChannelStore, isContextImpl } from './typeguards';

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
