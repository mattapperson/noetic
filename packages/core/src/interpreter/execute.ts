import { NoeticErrorImpl } from '../errors/noetic-error';
import { emitFrameworkEvent, getBroadcaster } from '../runtime/broadcaster-utils';
import type { Context } from '../types/context';
import type { ContextMemory } from '../types/memory';
import type { Step } from '../types/step';
import { executeBranch } from './execute-branch';
import { executeFork } from './execute-fork';
import { executeLLM } from './execute-llm';
import { executeLoop } from './execute-loop';
import { executeRun } from './execute-run';
import { executeSpawn } from './execute-spawn';
import { executeTool } from './execute-tool';
import { frameworkCast } from './framework-cast';
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
export async function execute<TMemory = ContextMemory, I = unknown, O = unknown>(
  step: Step<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
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

  // Emit step_started framework event
  const broadcaster = getBroadcaster(baseCtx);
  const agentName = baseCtx.harness.config.name;
  emitFrameworkEvent({
    broadcaster,
    agentName,
    eventType: 'step_started',
    data: {
      stepId: step.id,
      kind: step.kind,
    },
  });

  let result: O;
  switch (step.kind) {
    case 'run':
      result = await executeRun(step, input, ctx);
      break;
    case 'llm':
      result = await executeLLM(step, input, ctx, baseCtx.layers);
      break;
    case 'tool':
      result = await executeTool(step, input, ctx, baseCtx.harness);
      break;
    case 'branch':
      result = await executeBranch(step, input, ctx, (s, i, c) => execute(s, i, c));
      break;
    case 'fork':
      result = await executeFork(step, input, ctx, (s, i, c) => execute(s, i, c));
      break;
    case 'spawn':
      result = await executeSpawn(step, input, ctx, (s, i, c) => execute(s, i, c));
      break;
    case 'loop':
      result = await executeLoop(step, input, ctx, (s, i, c) => execute(s, i, c));
      break;
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

  // Emit step_completed framework event
  emitFrameworkEvent({
    broadcaster,
    agentName,
    eventType: 'step_completed',
    data: {
      stepId: step.id,
      kind: step.kind,
    },
  });

  return result;
}
