import type {
  Context,
  Step,
  StepRunCode,
  StepSpawn,
  StepSubprocessRequest,
  SubprocessAdapter,
} from '@noetic-tools/types';
import { frameworkCast, SubprocessLaunchError } from '@noetic-tools/types';
import { ContextImpl } from '../runtime/context-impl';
import { ChildAdapterSource, runsInProcess, spawnLinked } from '../runtime/durable/child-links';
import { DetachedHandleImpl } from '../util/detached-handle';
import { retryStep } from './execute-run-code';
import type { StepKindScope } from './step-kind-dispatch';
import { stepLaunch, withCommandLauncher } from './step-launch';

/**
 * Resolve the subprocess adapter that should handle dispatch for this step.
 * Precedence is `step.subprocess ?? ctx.harness.subprocess`. Per-call
 * `detachedSpawn` overrides layer above this in the harness itself.
 */
function resolveStepAdapter<TContext, I, O>(
  step: Step<TContext, I, O>,
  ctx: Context<TContext>,
): SubprocessAdapter {
  if ((step.kind === 'runCode' || step.kind === 'spawn') && step.subprocess) {
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
 *
 * `executionId` names the context the step body runs in: `ctx.id` for a
 * `runCode`, the pre-allocated child id for a `spawn` (whose request then
 * also names `ctx` as the parent).
 */
export async function dispatchViaAdapter<TContext, I, O>({
  step,
  input,
  scope,
  executionId,
  executor,
}: {
  step: StepRunCode<TContext, I, O> | StepSpawn<TContext, I, O>;
  input: I;
  scope: StepKindScope<TContext>;
  executionId: string;
  executor: (attempts?: number) => Promise<O>;
}): Promise<O> {
  const ctx = scope.stepCtx;
  const adapter = resolveStepAdapter(step, ctx);
  const plainCtx = frameworkCast<Context>(ctx);
  const external = !runsInProcess(adapter);
  const launch =
    step.kind === 'runCode'
      ? stepLaunch({
          scope,
          stepId: step.id,
          slot: 'subprocess',
          external,
        })
      : undefined;
  const command =
    step.kind === 'runCode'
      ? stepLaunch({
          scope,
          stepId: step.id,
          slot: 'command',
          external: true,
        })
      : undefined;
  await launch?.check();
  if (ctx instanceof ContextImpl && ctx.ledger?.mayHavePending) {
    await command?.check();
  }
  let entered = false;
  const local = (attempts?: number): Promise<O> => {
    entered = true;
    return command
      ? withCommandLauncher(plainCtx, command, () => executor(attempts))
      : executor(attempts);
  };
  const request: StepSubprocessRequest = {
    kind: 'step',
    stepId: step.id,
    serializedInput: input,
    executionId,
    parentExecutionId: executionId === ctx.id ? undefined : ctx.id,
    overrides: {
      threadId: ctx.threadId,
      resourceId: ctx.resourceId,
    },
    _localExecutor: () => local(),
  };
  const send = (request: StepSubprocessRequest) =>
    launch
      ? launch.send(
          () => adapter.spawn(request),
          () => !entered,
        )
      : adapter.spawn(request);
  const retry = step.kind === 'runCode' ? (step.execution?.retry ?? step.retry) : undefined;
  const spawned =
    executionId === ctx.id
      ? retry
        ? retryStep({
            stepId: step.id,
            ctx,
            retry,
            canRetry: (error) => !entered && error instanceof SubprocessLaunchError,
            run: (attempt) => {
              const attempts = retry.maxAttempts - attempt;
              return send({
                ...request,
                _localExecutor: () => local(attempts),
              });
            },
          })
        : send(request)
      : spawnLinked(ctx, adapter, {
          childId: executionId,
          stepId: step.id,
          from:
            step.subprocess === undefined ? ChildAdapterSource.Harness : ChildAdapterSource.Step,
          spawn: () => {
            if (ctx instanceof ContextImpl) {
              ctx.noteChildDispatch();
            }
            return send(request);
          },
        });
  return new DetachedHandleImpl<O>({
    id: executionId,
    stepId: step.id,
    spawned,
  }).await();
}
