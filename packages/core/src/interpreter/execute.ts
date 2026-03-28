import { NoeticErrorImpl } from '../errors/noetic-error';
import type { Context } from '../types/context';
import type { AgentHarness } from '../types/runtime';
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
  harness?: AgentHarness,
): Promise<O> {
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
      if (!callModel) {
        throw new NoeticErrorImpl({
          kind: 'step_failed',
          stepId: step.id,
          cause: new Error('callModel is required for LLM steps'),
          retriesExhausted: false,
        });
      }
      return executeLLM(step, input, ctx, callModel, harness);
    case 'tool':
      if (!harness) {
        throw new NoeticErrorImpl({
          kind: 'step_failed',
          stepId: step.id,
          cause: new Error('harness is required for tool steps'),
          retriesExhausted: false,
        });
      }
      return executeTool(step, input, ctx, harness);
    case 'branch':
      return executeBranch(step, input, ctx, (s, i, c) => execute(s, i, c, callModel, harness));
    case 'fork':
      return executeFork(step, input, ctx, (s, i, c) => execute(s, i, c, callModel, harness));
    case 'spawn':
      return executeSpawn(step, input, ctx, (s, i, c) => execute(s, i, c, callModel, harness));
    case 'loop':
      return executeLoop(step, input, ctx, (s, i, c) => execute(s, i, c, callModel, harness));
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
