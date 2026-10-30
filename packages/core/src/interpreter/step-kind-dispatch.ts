/**
 * Per-kind step routing: maps each step kind to its handler, and sends
 * `runCode`/`spawn` through the resolved subprocess adapter. `execute()` owns
 * the step lifecycle around this (depth/abort guards, events, ledger, checkpoint).
 */

import type { ContextLayer, LayerStateStore } from '@noetic-tools/context';
import type {
  Context,
  ExecuteStepFn,
  Step,
  StepRunCode,
  StepSpawn,
  StepSubprocessRequest,
  StorageAdapter,
  SubprocessAdapter,
} from '@noetic-tools/types';
import { frameworkCast, NoeticErrorImpl } from '@noetic-tools/types';
import { DetachedHandleImpl } from '../util/detached-handle';
import { executeAcpAgent } from './execute-acp-agent';
import {
  executeCallModel,
  executeRunCode,
  executeSpawn,
  executeWithContext,
} from './execute-action';
import { executeCall } from './execute-call';
import {
  executeConditional,
  executeInParallel,
  executeLoop,
  executeSchedule,
  executeSequence,
} from './execute-control';
import { executeDecide } from './execute-decide';
import { executeInvokeTool } from './execute-invoke-tool';
import { executeVerify } from './execute-verify';
import { executeWait } from './execute-wait';

//#region Types

/** What a kind handler needs beyond the step and its input. */
export interface StepKindScope<TContext> {
  /** The step's own lane — the context its body runs in. */
  stepCtx: Context<TContext>;
  /** The dispatching context, which carries the layers and the harness. */
  baseCtx: Context;
  /** The ledger key `execute()` resolved for this dispatch. */
  ledgerKey: string | undefined;
  /** Re-enters `execute()` for nested steps. */
  executeStep: ExecuteStepFn;
}

//#endregion

//#region Helpers

/**
 * Extract the parent's context layers and layer-state store so `executeSpawn`
 * can propagate them to the child context per `specs/04-spawn.md`: when a
 * spawn step has no explicit `context` config, parent layers inherit and their
 * `onSpawn`/`onReturn` hooks run across the boundary.
 *
 * `ctx.harness.layerStateStore` is not on the public `AgentHarnessContract`
 * (it's an internal runtime surface). Accessing it via `frameworkCast`
 * matches the internal-only pattern used elsewhere in the interpreter.
 */
interface HarnessWithLayerStore {
  layerStateStore: LayerStateStore;
  config?: {
    storage?: StorageAdapter;
  };
}

function harnessWithLayerStore<TContext>(ctx: Context<TContext>): HarnessWithLayerStore {
  return frameworkCast<HarnessWithLayerStore>(ctx.harness);
}

function buildSpawnOpts<TContext>(ctx: Context<TContext>): {
  itemSchemas: Context['itemSchemas'];
  parentLayers: ContextLayer[] | undefined;
  layerStore: LayerStateStore;
} {
  const baseCtx = frameworkCast<Context>(ctx);
  return {
    itemSchemas: baseCtx.itemSchemas,
    parentLayers: baseCtx.layers,
    layerStore: harnessWithLayerStore(baseCtx).layerStateStore,
  };
}

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
async function dispatchViaAdapter<TContext, I, O>(
  step: StepRunCode<TContext, I, O> | StepSpawn<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
  executionId: string,
  executor: () => Promise<O>,
): Promise<O> {
  const adapter = resolveStepAdapter(step, ctx);
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
    _localExecutor: () => executor(),
  };
  const handle = new DetachedHandleImpl<O>({
    id: executionId,
    stepId: step.id,
    spawned: adapter.spawn(request),
  });
  return handle.await();
}

//#endregion

//#region Public API

/**
 * Run a `runCode`/`spawn` step's handler in-process, without adapter routing;
 * every other kind re-enters `executeStep` so it gets the full dispatch path.
 */
export function executeLocally<TContext, I, O>(
  step: Step<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
  executeStep: ExecuteStepFn,
): Promise<O> {
  switch (step.kind) {
    case 'runCode':
      return executeRunCode(step, input, ctx);
    case 'spawn':
      return executeSpawn(step, input, ctx, executeStep, buildSpawnOpts(ctx));
    default:
      // Kinds that don't currently route through the adapter (callModel,
      // invokeTool, conditional, inParallel, withContext, loop, schedule).
      // Delegate back to `execute()`
      // so they exercise the normal dispatch table, framework-event emits,
      // abort checks, and depth guard.
      return executeStep(step, input, ctx);
  }
}

/** Route a step to its kind's handler and return the handler's output. */
export async function dispatchStepKind<TContext, I, O>(
  step: Step<TContext, I, O>,
  input: I,
  scope: StepKindScope<TContext>,
): Promise<O> {
  const { stepCtx, baseCtx, ledgerKey, executeStep } = scope;
  switch (step.kind) {
    case 'runCode':
      return dispatchViaAdapter(step, input, stepCtx, stepCtx.id, () =>
        executeRunCode(step, input, stepCtx),
      );
    case 'callModel':
      return executeCallModel(step, input, stepCtx, baseCtx.layers);
    case 'acp-agent':
      return executeAcpAgent(step, input, stepCtx, baseCtx.layers);
    case 'invokeTool':
      return executeInvokeTool(step, input, stepCtx, baseCtx.harness, baseCtx.layers);
    case 'decide':
      return executeDecide(step, input, stepCtx, baseCtx.layers);
    case 'conditional':
      return executeConditional(step, input, stepCtx, executeStep);
    case 'inParallel':
      return executeInParallel(step, input, stepCtx, executeStep, {
        // Fork paths are child executions: the layer store lets their
        // `onSpawn`/`onReturn` boundary run (see `createForkLayerBridge`).
        layerStore: harnessWithLayerStore(baseCtx).layerStateStore,
        itemSchemas: baseCtx.itemSchemas,
      });
    case 'spawn': {
      // Allocated here so the adapter request names the child it runs.
      const childId = crypto.randomUUID();
      return dispatchViaAdapter(step, input, stepCtx, childId, () =>
        executeSpawn(step, input, stepCtx, executeStep, {
          ...buildSpawnOpts(stepCtx),
          childId,
        }),
      );
    }
    case 'withContext':
      return executeWithContext(step, input, stepCtx, executeStep, {
        layerStore: harnessWithLayerStore(baseCtx).layerStateStore,
        storage: harnessWithLayerStore(baseCtx).config?.storage,
      });
    case 'loop':
      return executeLoop(step, input, stepCtx, executeStep);
    case 'schedule':
      return executeSchedule(step, input, stepCtx, executeStep);
    case 'call':
      return executeCall(step, input, stepCtx, {
        ledgerKey,
      });
    case 'wait':
      return executeWait(step, input, stepCtx, executeStep, {
        ledgerKey,
      });
    case 'verify':
      return executeVerify(step, input, stepCtx, executeStep);
    case 'sequence':
      return executeSequence(step, input, stepCtx, executeStep);
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
}

//#endregion
