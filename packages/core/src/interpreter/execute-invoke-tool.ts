/**
 * The `invokeTool` step handler: validate the arguments, pass the steering and
 * approval gates, run the tool (streaming generator progress), and trace it.
 */

import type { Span, SteeringDecision } from '@noetic-tools/types';
import { frameworkCast, NoeticErrorImpl, validateSchema } from '@noetic-tools/types';
import { ToolAttr } from '../observability/genai-attributes';
import { askApproval } from '../runtime/tool-approval';
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

  if (step.tool.needsApproval) {
    const approval = await askApproval({
      harness,
      toolName: step.tool.name,
      toolArgs: parsedArgs,
      callId: step.id,
      ctx: baseCtx,
    });
    span.setAttribute(ToolAttr.APPROVAL, approval.outcome);
    if (approval.decision.action !== SteeringAction.Allow) {
      refuse(approval.decision);
    }
  }

  emitToolUi({
    ctx: baseCtx,
    tool: step.tool,
    callId: step.id,
    phase: 'call',
    args: parsedArgs,
  });
  try {
    const toolCtx = buildToolExecutionContext(baseCtx, harness);
    const execResult = step.tool.execute(parsedArgs, toolCtx);

    const result = isAsyncGenerator(execResult)
      ? await consumeToolGenerator({
          generator: execResult,
          stepId: step.id,
          tool: step.tool,
          ctx: baseCtx,
          args: parsedArgs,
        })
      : await execResult;

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
      throw e;
    }
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: e instanceof Error ? e : new Error(String(e)),
      retriesExhausted: false,
    });
  }
}

//#endregion
