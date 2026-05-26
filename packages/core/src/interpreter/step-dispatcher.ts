import { DetachedHandleImpl } from '../runtime/detached-handle';
import type { Context } from '../types/context';
import type { DetachedHandle } from '../types/detached';
import type { ContextMemory } from '../types/memory';
import type { Step } from '../types/step';
import type { StepSubprocessRequest, SubprocessAdapter } from '../types/subprocess-adapter';
import { executeNoAdapter } from './execute';

//#region Adapter resolution

/**
 * Resolve the subprocess adapter used for a given step dispatch.
 *
 * Precedence: `detachedSpawn-overrides.subprocess ?? step.subprocess ??
 * harness.subprocess`. Only `StepRun` and `StepSpawn` currently carry a
 * `subprocess` field — other variants always fall through to the harness
 * default.
 *
 * @internal
 */
export function resolveStepAdapter<TMemory, I, O>(
  step: Step<TMemory, I, O>,
  callOverride: SubprocessAdapter | undefined,
  fallback: SubprocessAdapter,
): SubprocessAdapter {
  if (callOverride) {
    return callOverride;
  }
  if ((step.kind === 'run' || step.kind === 'spawn') && step.subprocess) {
    return step.subprocess;
  }
  return fallback;
}

//#endregion

//#region Dispatch handle

/**
 * Minimum harness surface the dispatcher needs. `AgentHarness` satisfies
 * this shape — kept structural so tests can pass a stub.
 *
 * @internal
 */
export interface StepDispatchHandle {
  readonly subprocess: SubprocessAdapter;
  createContext(opts?: {
    parent?: Context;
    threadId?: string;
    resourceId?: string;
    cwdInit?: string;
  }): Context;
}

export interface DetachedSpawnOverrides {
  /** Override the child's thread id. Default inherits from `parentCtx.threadId`. */
  threadId?: string;
  /** Override the child's resource id. Default inherits from `parentCtx.resourceId`. */
  resourceId?: string;
  /** Override the child's initial cwd. Used by worktree isolation to root the child at the worktree path. */
  cwdInit?: string;
  /**
   * Per-call subprocess adapter override. Takes precedence over both
   * `step.subprocess` and `harness.subprocess`. Pass a custom adapter to
   * dispatch this specific spawn through a different runtime (e.g. a
   * local OS subprocess or a test double that records the request).
   */
  subprocess?: SubprocessAdapter;
}

//#endregion

//#region Dispatcher

/**
 * Route a step through the configured subprocess adapter and return a
 * `DetachedHandle` that polls until the adapter reports a terminal
 * status. The adapter's `spawn()` may be async (the default in-memory
 * adapter schedules the step body on the microtask queue, and
 * out-of-process adapters may await an OS spawn).
 *
 * `executeNoAdapter` is used as the local executor so the adapter we just
 * routed through does not re-route the same step. The handler still uses
 * `execute()` for nested children, so per-step overrides on descendants
 * keep working.
 *
 * @internal
 */
export function dispatchStepThroughAdapter<I, O>(
  h: StepDispatchHandle,
  s: Step<ContextMemory, I, O>,
  input: I,
  parentCtx: Context,
  overrides?: DetachedSpawnOverrides,
): DetachedHandle<O> {
  const childCtx = h.createContext({
    parent: parentCtx,
    threadId: overrides?.threadId ?? parentCtx.threadId,
    resourceId: overrides?.resourceId ?? parentCtx.resourceId,
    cwdInit: overrides?.cwdInit,
  });
  const adapter = resolveStepAdapter(s, overrides?.subprocess, h.subprocess);
  const request: StepSubprocessRequest = {
    kind: 'step',
    stepId: s.id,
    serializedInput: input,
    executionId: childCtx.id,
    overrides: {
      threadId: overrides?.threadId ?? parentCtx.threadId,
      resourceId: overrides?.resourceId ?? parentCtx.resourceId,
      cwdInit: overrides?.cwdInit,
    },
    _localExecutor: () => executeNoAdapter(s, input, childCtx),
  };
  const spawnPromise = adapter.spawn(request);
  return new DetachedHandleImpl<O>({
    id: childCtx.id,
    stepId: s.id,
    adapter,
    spawnPromise,
  });
}

//#endregion
