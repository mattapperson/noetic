/**
 * The `invokeTool` step handler: validate the arguments, pass the steering and
 * approval gates, run the tool (streaming generator progress), and trace it.
 */

import type { Span, SteeringDecision } from '@noetic-tools/types';
import { frameworkCast, NoeticErrorImpl, validateSchema } from '@noetic-tools/types';
import { orderedCallId } from '../connections/durability';
import { ToolAttr } from '../observability/genai-attributes';
import { ContextImpl } from '../runtime/context-impl';
import type { HeldRecord, HoldHost } from '../runtime/held-calls';
import {
  heldArgsHash,
  heldCallsOf,
  heldScopeOf,
  holdAndWait,
  mayWriteHolds,
} from '../runtime/held-calls';
import { awaitApproval } from '../runtime/tool-approval';
import { isToolHold } from '../runtime/tool-call';
import { emitToolUi } from '../runtime/tool-ui';
import { buildToolExecutionContext, emitFrameworkEvent, getBroadcaster } from './action-deps';
import type {
  AgentHarnessContract,
  Context,
  ContextData,
  ContextLayer,
  StepInvokeTool,
  Tool,
} from './action-types';
import { SteeringAction } from './action-types';
import { openChildSpan, traceChild } from './child-span';
import { runRootOf } from './connection-steps';

//#region tool

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return Symbol.asyncIterator in value;
}

async function consumeToolGenerator(params: {
  generator: AsyncGenerator<unknown, unknown>;
  stepId: string;
  tool: Tool;
  ctx: Context<ContextData>;
  args: unknown;
}): Promise<unknown> {
  const broadcaster = getBroadcaster(params.ctx);
  const agentName = params.ctx.harness.config.name;
  const events: unknown[] = [];

  while (true) {
    const next = await params.generator.next();
    if (next.done) {
      return next.value;
    }

    events.push(next.value);
    emitFrameworkEvent({
      broadcaster,
      agentName,
      eventType: 'tool_progress',
      data: {
        stepId: params.stepId,
        toolName: params.tool.name,
        event: next.value,
      },
    });
    // A direct `invokeTool` has no model call id — the step id keys its region.
    emitToolUi({
      ctx: params.ctx,
      tool: params.tool,
      callId: params.stepId,
      phase: 'progress',
      args: params.args,
      events,
    });
  }
}

/**
 * Runs an `invokeTool` step inside a `tool.call` span under `ctx.span`. The span
 * covers validation, the steering gate, and execution, so a denied or failing
 * call is traced with its error.
 */
export async function executeInvokeTool<TContext, I, O>(
  step: StepInvokeTool<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
  harness: AgentHarnessContract,
  layers?: ContextLayer[],
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextData>>(ctx);
  const span = openChildSpan(baseCtx, 'tool.call', step.id);
  span.setAttribute(ToolAttr.NAME, step.tool.name);
  span.setAttribute(ToolAttr.NEEDS_APPROVAL, step.tool.needsApproval ?? false);
  return traceChild(baseCtx, span, () =>
    runInvokeTool(step, input, baseCtx, harness, layers, span),
  );
}

/**
 * Gates run in order — input validation, the `beforeToolCall` layers, then the
 * harness approver for a tool that declares `needsApproval` — and a refusal at
 * any gate throws `steering_denied` before the tool runs.
 */
async function runInvokeTool<TContext, I, O>(
  step: StepInvokeTool<TContext, I, O>,
  input: I,
  baseCtx: Context<ContextData>,
  harness: AgentHarnessContract,
  layers: ContextLayer[] | undefined,
  span: Span,
): Promise<O> {
  const args = step.args ? Object.assign({}, input, step.args) : input;

  const parseResult = await validateSchema(step.tool.input, args);
  if (!parseResult.success) {
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: new Error(`Tool input validation failed: ${parseResult.zodError.message}`),
      retriesExhausted: false,
    });
  }
  const parsedArgs = parseResult.value;

  // The started event precedes the gate so a parked call (e.g. one awaiting an
  // external permission decision) is visible as pending rather than invisible
  // until approved — the same ordering the model-driven path guarantees.
  const broadcaster = getBroadcaster(baseCtx);
  const agentName = baseCtx.harness.config.name;
  emitFrameworkEvent({
    broadcaster,
    agentName,
    eventType: 'tool_call_started',
    data: {
      name: step.tool.name,
      callId: step.id,
    },
  });
  const emitCompleted = (error: boolean, output?: string): void => {
    emitFrameworkEvent({
      broadcaster,
      agentName,
      eventType: 'tool_call_completed',
      data: {
        name: step.tool.name,
        callId: step.id,
        error,
        output,
      },
    });
  };

  const refuse = (decision: SteeringDecision): never => {
    emitCompleted(true, `Tool call denied: ${decision.guidance ?? 'steering rule violation'}`);
    throw new NoeticErrorImpl({
      kind: 'steering_denied',
      guidance: decision.guidance,
    });
  };

  if (layers && layers.length > 0) {
    const decision = await harness.beforeToolCall(
      layers,
      step.tool.name,
      parsedArgs,
      baseCtx,
      step.id,
    );
    if (decision.action !== SteeringAction.Allow) {
      refuse(decision);
    }
  }

  // Held calls of this step, and its idempotency key, go under its dispatch path:
  // a step id repeats across loop iterations and parallel branches, a path does
  // not. A run with no ledger has no path, so the call is told apart by its order
  // among this step's calls in the run.
  const holdId =
    (baseCtx instanceof ContextImpl ? baseCtx.currentDispatch()?.path : undefined) ??
    orderedCallId(runRootOf(baseCtx), baseCtx, step.id);

  const held = {
    callId: holdId,
    name: step.tool.name,
    args: parsedArgs,
    argsHash: heldArgsHash(step.tool.name, parsedArgs),
  };
  const holds = heldCallsOf(harness);
  const holdScope = heldScopeOf(baseCtx);

  // The body already ran, and left its result for a person to give: the turn
  // parked on it, or was cut off, and this is the step coming back. Running the
  // body again would ask the question a second time.
  const left = await holds.load(holdScope, holdId);
  if (left?.reason === 'result' && left.argsHash === held.argsHash) {
    const result = await heldResult(
      {
        harness,
        ctx: baseCtx,
        stepId: step.id,
      },
      left,
    );
    emitToolUi({
      ctx: baseCtx,
      tool: step.tool,
      callId: step.id,
      phase: 'result',
      args: parsedArgs,
      output: result,
    });
    emitCompleted(false, typeof result === 'string' ? result : JSON.stringify(result));
    return frameworkCast<O>(result);
  }

  // A durable call a host died inside had its approval before it started. What a
  // person is asked now is how it ended, not whether it may run.
  const wasCutOff =
    step.tool.durable === true &&
    (await heldCallsOf(harness).wasStarted(
      heldScopeOf(baseCtx),
      holdId,
      heldArgsHash(step.tool.name, parsedArgs),
    ));

  if (step.tool.needsApproval && !wasCutOff) {
    const approval = await awaitApproval({
      harness,
      toolName: step.tool.name,
      toolArgs: parsedArgs,
      // The approver sees the step's id; the hold goes under an id unique to this call.
      callId: step.id,
      recordId: holdId,
      ctx: baseCtx,
    });
    span.setAttribute(ToolAttr.APPROVAL, approval.outcome);
    if (approval.decision.action !== SteeringAction.Allow) {
      refuse(approval.decision);
    }
  }

  // A durable tool is not repeated unasked (spec 23a § Tool calls in a round). An
  // intent with no result means a host died while it ran: a person says what happened.
  const durable = step.tool.durable === true;
  if (durable && baseCtx instanceof ContextImpl) {
    baseCtx.ledger?.noteEffect(baseCtx.currentDispatch()?.path);
  }
  if (durable && (await holds.wasStarted(holdScope, holdId, held.argsHash))) {
    const answer = await holdAndWait({
      harness,
      ctx: baseCtx,
      record: {
        ...held,
        reason: 'outcome',
      },
    });
    if (answer.resolution?.hasOutput) {
      emitCompleted(false, JSON.stringify(answer.resolution.output));
      return frameworkCast<O>(answer.resolution.output);
    }
    const action = answer.resolution?.action ?? SteeringAction.Deny;
    if (action !== SteeringAction.Allow) {
      refuse({
        action,
        guidance: answer.resolution?.guidance,
      });
    }
  }
  if (durable && mayWriteHolds(baseCtx)) {
    await holds.arm(holdScope, holdId, held.argsHash);
  }
  // The tool reported back with an error: its outcome is known, and it may be tried
  // again. A result is another matter. It is on record only once the step's own
  // ledger entry is written, after this returns, so the intent stays until the
  // run's records are cleared: a host that dies in between resumes to a held
  // call, not to the tool running a second time unasked.
  const disarm = async (): Promise<void> => {
    if (durable && mayWriteHolds(baseCtx)) {
      await holds.disarm(holdScope, holdId);
    }
  };

  emitToolUi({
    ctx: baseCtx,
    tool: step.tool,
    callId: step.id,
    phase: 'call',
    args: parsedArgs,
  });
  try {
    // The step's place in the run is its key: a resumed step sends the same one.
    const toolCtx = buildToolExecutionContext(baseCtx, harness, {
      recordId: holdId,
    });
    const execResult = step.tool.execute(parsedArgs, toolCtx);

    const ran = isAsyncGenerator(execResult)
      ? await consumeToolGenerator({
          generator: execResult,
          stepId: step.id,
          tool: step.tool,
          ctx: baseCtx,
          args: parsedArgs,
        })
      : await execResult;
    // The tool did its part and left the result for a person to give.
    const result = isToolHold(ran)
      ? await heldResult(
          {
            harness,
            ctx: baseCtx,
            stepId: step.id,
          },
          {
            ...held,
            reason: 'result',
            ...(ran.dueAt === undefined
              ? {}
              : {
                  dueAt: ran.dueAt,
                }),
            ...(ran.onDue === undefined
              ? {}
              : {
                  onDue: ran.onDue,
                }),
            ...(ran.request === undefined
              ? {}
              : {
                  request: ran.request,
                }),
          },
        )
      : ran;

    emitToolUi({
      ctx: baseCtx,
      tool: step.tool,
      callId: step.id,
      phase: 'result',
      args: parsedArgs,
      output: result,
    });
    emitCompleted(false, typeof result === 'string' ? result : JSON.stringify(result));
    return frameworkCast<O>(result);
  } catch (e) {
    emitToolUi({
      ctx: baseCtx,
      tool: step.tool,
      callId: step.id,
      phase: 'error',
      args: parsedArgs,
      error: e,
    });
    emitCompleted(true, e instanceof Error ? e.message : String(e));
    if (e instanceof NoeticErrorImpl) {
      // A run cut short was not the tool reporting back: its outcome stays unknown.
      if (e.noeticError.kind !== 'cancelled') {
        await disarm();
      }
      throw e;
    }
    await disarm();
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: e instanceof Error ? e : new Error(String(e)),
      retriesExhausted: false,
    });
  }
}

//#endregion

//#region Held results

/**
 * Wait for the answer to a result a tool left open with `hold()`.
 *
 * @throws NoeticError `step_failed` when the hold's deadline passes with no answer,
 *   `cancelled` when the context is aborted while it waits.
 */
async function heldResult(
  at: {
    harness: HoldHost;
    ctx: Context;
    stepId: string;
  },
  record: HeldRecord,
): Promise<unknown> {
  const answer = await holdAndWait({
    harness: at.harness,
    ctx: at.ctx,
    record,
  });
  if (answer.resolution?.hasOutput) {
    return answer.resolution.output;
  }
  throw new NoeticErrorImpl({
    kind: 'step_failed',
    stepId: at.stepId,
    cause: new Error(`nobody answered '${record.name}' before the hold ran out`),
    retriesExhausted: true,
  });
}

//#endregion
