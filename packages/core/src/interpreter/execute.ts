import { NoeticErrorImpl } from '../errors/noetic-error';
import { emitFrameworkEvent, getBroadcaster, shouldEmit } from '../runtime/broadcaster-utils';
import { ContextImpl } from '../runtime/context-impl';
import { DetachedHandleImpl } from '../runtime/detached-handle';
import type { Context } from '../types/context';
import type { ContextMemory } from '../types/memory';
import type { Step, StepRun, StepSpawn } from '../types/step';
import type { StepSubprocessRequest, SubprocessAdapter } from '../types/subprocess-adapter';
import { frameworkCast } from '../util/framework-cast';
import {
  executeLLM,
  executeProvide,
  executeRun,
  executeSpawn,
  executeTool,
} from './execute-action';
import { executeBranch, executeEvery, executeFork, executeLoop } from './execute-control';
import { isMutableContext } from './typeguards';

//#region Constants

const MAX_DEPTH = 64;

//#endregion

//#region Helpers

/**
 * Return the underlying `ContextImpl` when the context is one we produced
 * in-process. Out-of-process descendants reach us through the adapter
 * boundary and are not `ContextImpl` instances, so frontier bookkeeping is
 * a no-op for them.
 */
function asContextImpl(ctx: Context): ContextImpl | null {
  return ctx instanceof ContextImpl ? ctx : null;
}

/**
 * Resolve the subprocess adapter that should handle dispatch for this step.
 * Precedence is `step.subprocess ?? ctx.harness.subprocess`. Per-call
 * `detachedSpawn` overrides layer above this in the harness itself.
 */
function resolveStepAdapter<TMemory, I, O>(
  step: Step<TMemory, I, O>,
  ctx: Context<TMemory>,
): SubprocessAdapter {
  if ((step.kind === 'run' || step.kind === 'spawn') && step.subprocess) {
    return step.subprocess;
  }
  return ctx.harness.subprocess;
}

/**
 * Dispatch a run/spawn step through the resolved subprocess adapter.
 *
 * The `_localExecutor` closure carries the in-process fallback path — the
 * in-memory adapter invokes it directly, preserving the pre-refactor
 * dispatch semantics including parent-context inheritance, layer lifecycle,
 * and synchronous error propagation. Out-of-process adapters ignore
 * `_localExecutor` and run the step in a child runtime.
 */
async function dispatchViaAdapter<TMemory, I, O>(
  step: StepRun<TMemory, I, O> | StepSpawn<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  executor: () => Promise<O>,
): Promise<O> {
  const adapter = resolveStepAdapter(step, ctx);
  const request: StepSubprocessRequest = {
    kind: 'step',
    stepId: step.id,
    serializedInput: input,
    executionId: ctx.id,
    overrides: {
      threadId: ctx.threadId,
      resourceId: ctx.resourceId,
    },
    _localExecutor: () => executor(),
  };
  const spawnPromise = adapter.spawn(request);
  const handle = new DetachedHandleImpl<O>({
    id: ctx.id,
    stepId: step.id,
    adapter,
    spawnPromise,
  });
  return handle.await();
}

/**
 * @internal
 * Dispatch a step at the per-kind handler level without adapter routing.
 *
 * Used as the top-level `_localExecutor` for `StepRun` / `StepSpawn`
 * dispatches: the outer adapter call already recorded the request, so
 * running the handler directly avoids a re-entrant adapter round-trip
 * inside the same logical step. Nested step dispatches (e.g. `executeSpawn`
 * descending into `step.child`) still go through `execute()` and route
 * through the adapter as normal, so per-step overrides on descendants
 * continue to work.
 */
export async function executeNoAdapter<TMemory, I, O>(
  step: Step<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
): Promise<O> {
  const baseCtx = frameworkCast<Context>(ctx);
  switch (step.kind) {
    case 'run':
      return executeRun(step, input, ctx);
    case 'spawn':
      return executeSpawn(step, input, ctx, (s, i, c) => execute(s, i, c), {
        itemSchemas: baseCtx.itemSchemas,
      });
    default:
      // Kinds that don't currently route through the adapter (llm, tool,
      // branch, fork, provide, loop, every). Delegate back to `execute()`
      // so they exercise the normal dispatch table, framework-event emits,
      // abort checks, and depth guard.
      return execute(step, input, ctx);
  }
}

//#endregion

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

  // Push onto the durable frontier so checkpoints can record exactly which
  // step was in flight when the snapshot fired. Steps with empty ids are
  // skipped — they are not reattachable by id and would pollute the stack.
  const impl = asContextImpl(baseCtx);
  if (impl && step.id.length > 0) {
    impl.enterStep({
      stepId: step.id,
      input,
    });
  }

  let result: O;
  try {
    switch (step.kind) {
      case 'run':
        result = await dispatchViaAdapter(step, input, ctx, () => executeRun(step, input, ctx));
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
        result = await dispatchViaAdapter(step, input, ctx, () =>
          executeSpawn(step, input, ctx, (s, i, c) => execute(s, i, c), {
            itemSchemas: baseCtx.itemSchemas,
          }),
        );
        break;
      case 'provide':
        result = await executeProvide(step, input, ctx, (s, i, c) => execute(s, i, c));
        break;
      case 'loop':
        result = await executeLoop(step, input, ctx, (s, i, c) => execute(s, i, c));
        break;
      case 'every':
        result = await executeEvery(step, input, ctx, (s, i, c) => execute(s, i, c));
        break;
      default: {
        const _exhaustive: never = step;
        void _exhaustive;
        throw new NoeticErrorImpl({
          kind: 'step_failed',
          stepId: 'unknown',
          cause: new Error('Unknown step kind'),
          retriesExhausted: false,
        });
      }
    }
  } finally {
    if (impl && step.id.length > 0) {
      impl.leaveStep(step.id);
    }
  }

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
}
