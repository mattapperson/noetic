import { NoeticErrorImpl } from '../errors/noetic-error';
import { emitFrameworkEvent, getBroadcaster, shouldEmit } from '../runtime/broadcaster-utils';
import type { Context } from '../types/context';
import type { ContextMemory } from '../types/memory';
import type { Step } from '../types/step';
import { executeBranch } from './execute-branch';
import { executeFork } from './execute-fork';
import { executeLLM } from './execute-llm';
import { executeLoop } from './execute-loop';
import { executeProvide } from './execute-provide';
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

  // Create span for this step execution
  const span = ctx.harness.createSpan(step.id, ctx.span);
  span.setAttribute('stepKind', step.kind);
  span.setAttribute('input', JSON.stringify(input));

  // Depth guard — classified as step_failed (not budget_exceeded) because depth
  // is a structural safety limit, not a user-configurable budget field.
  if (ctx.depth >= MAX_DEPTH) {
    span.end();
    await ctx.harness.traceExporter.export([
      span,
    ]);
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: new Error(`Maximum spawn depth ${MAX_DEPTH} exceeded (depth: ${ctx.depth})`),
      retriesExhausted: true,
    });
  }

  // Abort check
  if (ctx.aborted) {
    span.end();
    await ctx.harness.traceExporter.export([
      span,
    ]);
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
  const emit = step.kind === 'llm' ? step.emit : undefined;
  if (shouldEmit(emit, 'step_started', startedData)) {
    emitFrameworkEvent({
      broadcaster,
      agentName,
      eventType: 'step_started',
      data: startedData,
    });
  }

  let result: O;
  try {
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
      case 'provide':
        result = await executeProvide(step, input, ctx, (s, i, c) => execute(s, i, c));
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

    // Success - end span and export
    span.setAttribute('output', JSON.stringify(result));
    span.setAttribute('tokenInput', ctx.tokens.input);
    span.setAttribute('tokenOutput', ctx.tokens.output);
    span.setAttribute('totalTokens', ctx.tokens.input + ctx.tokens.output);
    span.setAttribute('cost', ctx.cost);
    span.setAttribute('state', JSON.stringify(ctx.state));
    if (step.kind === 'llm') {
      span.setAttribute('model', step.model);
    }
    span.end();
    await ctx.harness.traceExporter.export([
      span,
    ]);

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

    return result;
  } catch (error) {
    // Error - end span and export
    span.end();
    await ctx.harness.traceExporter.export([
      span,
    ]);

    // Emit step_failed framework event (always emitted for errors)
    const failedData = {
      stepId: step.id,
      kind: step.kind,
      error: error instanceof Error ? error.message : String(error),
    };
    emitFrameworkEvent({
      broadcaster,
      agentName,
      eventType: 'step_failed',
      data: failedData,
    });

    throw error;
  }
}
