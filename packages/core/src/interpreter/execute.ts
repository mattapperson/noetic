import { NoeticErrorImpl } from '../errors/noetic-error';
import type { Context } from '../types/context';
import type { Step } from '../types/step';
import { executeBranch } from './execute-branch';
import { executeFork } from './execute-fork';
import { executeLLM } from './execute-llm';
import { executeLoop } from './execute-loop';
import { executeRun } from './execute-run';
import { executeSpawn } from './execute-spawn';
import { executeTool } from './execute-tool';
import { isMutableContext } from './typeguards';

const MAX_DEPTH = 64;

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
export async function execute<I, O>(step: Step<I, O>, input: I, ctx: Context): Promise<O> {
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
  if (isMutableContext(ctx)) {
    ctx.stepCount = (ctx.stepCount || 0) + 1;
  }

  switch (step.kind) {
    case 'run':
      return executeRun(step, input, ctx);
    case 'llm':
      return executeLLM(step, input, ctx, ctx.layers);
    case 'tool':
      return executeTool(step, input, ctx, ctx.harness);
    case 'branch':
      return executeBranch(step, input, ctx, (s, i, c) => execute(s, i, c));
    case 'fork':
      return executeFork(step, input, ctx, (s, i, c) => execute(s, i, c));
    case 'spawn':
      return executeSpawn(step, input, ctx, (s, i, c) => execute(s, i, c));
    case 'loop':
      return executeLoop(step, input, ctx, (s, i, c) => execute(s, i, c));
    default: {
      const _exhaustive: never = step;
      throw new NoeticErrorImpl({
        kind: 'step_failed',
        stepId: 'unknown',
        cause: new Error('Unknown step kind'),
        retriesExhausted: false,
      });
    }
  }
}
