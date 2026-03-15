import { OrchidErrorImpl } from '../errors/orchid-error';
import type { Context } from '../types/context';
import type { Step } from '../types/step';
import { executeBranch } from './execute-branch';
import { executeFork } from './execute-fork';
import type { CallModelFn } from './execute-llm';
import { executeLLM } from './execute-llm';
import { executeLoop } from './execute-loop';
import { executeRun } from './execute-run';
import { executeSpawn } from './execute-spawn';
import { executeTool } from './execute-tool';
import { isMutableContext } from './typeguards';

const MAX_DEPTH = 64;

export async function execute<I, O>(
  step: Step<I, O>,
  input: I,
  ctx: Context,
  callModel?: CallModelFn,
): Promise<O> {
  // Depth guard
  if (ctx.depth >= MAX_DEPTH) {
    throw new OrchidErrorImpl({
      kind: 'budget_exceeded',
      field: 'depth',
      limit: MAX_DEPTH,
      actual: ctx.depth,
    });
  }

  // Abort check
  if (ctx.aborted) {
    throw new OrchidErrorImpl({
      kind: 'cancelled',
      reason: ctx.abortReason ?? 'context aborted',
    });
  }

  // Increment step count
  if (isMutableContext(ctx)) {
    ctx.stepCount = (ctx.stepCount || 0) + 1;
  }

  switch (step.kind) {
    case 'run':
      return executeRun(step, input, ctx);
    case 'llm':
      if (!callModel) {
        throw new OrchidErrorImpl({
          kind: 'step_failed',
          stepId: step.id,
          cause: new Error('callModel is required for LLM steps'),
          retriesExhausted: false,
        });
      }
      return executeLLM(step, input, ctx, callModel);
    case 'tool':
      return executeTool(step, input, ctx);
    case 'branch':
      return executeBranch(step, input, ctx, (s, i, c) => execute(s, i, c, callModel));
    case 'fork':
      return executeFork(step, input, ctx, (s, i, c) => execute(s, i, c, callModel));
    case 'spawn':
      return executeSpawn(step, input, ctx, (s, i, c) => execute(s, i, c, callModel), callModel);
    case 'loop':
      return executeLoop(step, input, ctx, (s, i, c) => execute(s, i, c, callModel));
    default: {
      const _exhaustive: never = step;
      throw new OrchidErrorImpl({
        kind: 'step_failed',
        stepId: 'unknown',
        cause: new Error('Unknown step kind'),
        retriesExhausted: false,
      });
    }
  }
}
