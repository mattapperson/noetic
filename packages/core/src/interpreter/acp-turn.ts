import type {
  AcpContentBlock,
  AcpSession,
  AcpTurnResult,
  Context,
  ContextData,
  LLMResponse,
  RoundUsage,
  StepAcpAgent,
  StepMeta,
} from '@noetic-tools/types';
import {
  extractAssistantText,
  frameworkCast,
  isAcpCapabilityError,
  isAcpConnectError,
  isNoeticError,
  NoeticConfigError,
  NoeticErrorImpl,
} from '@noetic-tools/types';
import { ContextImpl } from '../runtime/context-impl';
import { TURN_CUT_ABORT } from '../runtime/durable/parking';
import { isRpcError, RpcFailure } from '../util/error-message';
import { modelOf } from './acp-activity';
import type { AcpEventBridge } from './acp-events';
import type { AcpToolRunner } from './acp-tools';
import { mergeBridgedItems } from './acp-tools';
import { trackUsage } from './message-helpers';
import { parseStructuredOutput } from './structured-output';
import { turnEndingIn } from './turn-ending';
import { abortSignalOf, isFunctionCall, isMutableContext } from './typeguards';

//#region Turn input and result

/**
 * Build the turn's prompt content. Plain text comes first (seeded with the
 * conversation so far on a fresh session), then any explicit content blocks.
 */
export function buildContent(opts: {
  text: string;
  blocks?: ReadonlyArray<AcpContentBlock>;
}): AcpContentBlock[] {
  const content: AcpContentBlock[] = [];
  if (opts.text.length > 0) {
    content.push({
      type: 'text',
      text: opts.text,
    });
  }
  if (opts.blocks) {
    content.push(...opts.blocks);
  }
  return content;
}

/**
 * The turn's tokens as a model round reports them, from the adapter (its
 * `usageOf`). The protocol makes what a `session/prompt` answer reports the
 * session's running total, so without the adapter nothing is charged.
 */
function turnUsage(result: AcpTurnResult): RoundUsage | undefined {
  return result.usage;
}

/** The turn as a model call's response, for usage accounting and `afterModelCall` layers. */
export function toLlmResponse(result: AcpTurnResult): LLMResponse {
  return {
    items: result.items,
    usage: turnUsage(result) ?? {
      inputTokens: 0,
      outputTokens: 0,
    },
    cost: result.cost,
  };
}

/**
 * The model the session runs with: its `model` config option's current value —
 * found as the session finds it to set it, by category, else by id — else the
 * model the step selected.
 */
export function currentModel(
  session: AcpSession,
  selected: string | undefined,
): string | undefined {
  return modelOf(session.configOptions) ?? selected;
}

/** Record a turn's items and charge its spend: every attempt, as every model call is. */
export function applyTurnResult(ctx: Context<ContextData>, result: AcpTurnResult): void {
  for (const item of result.items) {
    ctx.itemLog.append(item);
  }
  trackUsage(ctx, toLlmResponse(result));
}

/** Publish the accepted turn's metadata, as a `callModel` step does once its outcome is settled. */
export function publishStepMeta(
  ctx: Context<ContextData>,
  result: AcpTurnResult,
  model: string | undefined,
): void {
  const toolCalls = result.items.filter(isFunctionCall);
  const stopReason = result.stopReason;
  const meta: StepMeta = {
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: turnUsage(result),
    cost: result.cost,
    responseItems: result.items,
    // Only a turn that returned is accepted: a refusal or a cancellation fails the step.
    ...(stopReason === 'end_turn' ||
    stopReason === 'max_tokens' ||
    stopReason === 'max_turn_requests'
      ? {
          stopReason,
        }
      : {}),
    ...(model === undefined
      ? {}
      : {
          model,
        }),
  };
  if (isMutableContext(ctx)) {
    ctx.lastStepMeta = meta;
  }
}

/**
 * Turn a stop reason into the step's outcome. A refusal and a cancellation are
 * genuine failures with dedicated error kinds; a token or turn cap is a normal
 * return whose reason is recorded on `lastStepMeta` for the caller to inspect.
 */
export function assertTurnSucceeded(
  stepId: string,
  result: AcpTurnResult,
  ctx: Context<ContextData>,
): void {
  if (result.stopReason === 'cancelled') {
    throw new NoeticErrorImpl({
      kind: 'cancelled',
      reason: ctx.abortReason ?? 'the ACP agent reported a cancelled turn',
    });
  }
  if (result.stopReason === 'refusal') {
    throw new NoeticErrorImpl({
      kind: 'model_refused',
      stepId,
      refusal: result.text.length > 0 ? result.text : 'the ACP agent refused to continue',
    });
  }
}

/**
 * Whatever went wrong, as a Noetic error (spec 27 § Failures are Noetic errors):
 * a host never sees a protocol error. A missing capability is the workflow's
 * configuration; everything else the agent did, or failed to do, is the step
 * failing, with the agent's own message.
 */
export function stepFailure(
  step: {
    id: string;
  },
  cause: unknown,
  baseCtx: Context<ContextData>,
): NoeticErrorImpl | NoeticConfigError {
  if (cause instanceof NoeticErrorImpl || cause instanceof NoeticConfigError) {
    return cause;
  }
  if (isAcpCapabilityError(cause)) {
    return new NoeticConfigError({
      code: 'AGENT_CAPABILITY_MISSING',
      message: `step.acpAgent(${JSON.stringify(step.id)}): ${cause.message}`,
      hint: `The agent does not support '${cause.capability}'. Leave that setting off this step, or use an agent that supports it.`,
    });
  }
  if (baseCtx.aborted) {
    if (baseCtx instanceof ContextImpl && baseCtx.abortReason?.startsWith('lease_lost: ')) {
      try {
        baseCtx.ledger?.assertHeld();
      } catch (error) {
        if (error instanceof NoeticErrorImpl) {
          return error;
        }
        throw error;
      }
    }
    return new NoeticErrorImpl({
      kind: 'cancelled',
      reason: baseCtx.abortReason ?? 'context aborted',
    });
  }
  return new NoeticErrorImpl({
    kind: 'step_failed',
    stepId: step.id,
    // A JSON-RPC rejection keeps its detail (`data`) in the message, so a
    // failure reads "Internal error: Authentication required (-32603)", never
    // "[object Object]" or a bare "Internal error".
    cause: cause instanceof Error && !isRpcError(cause) ? cause : new RpcFailure(cause),
    retriesExhausted: false,
  });
}

export interface TurnError {
  error?: unknown;
  cancel?: () => Promise<void>;
}

//#endregion

//#region Turn execution

/**
 * One agent turn: prompt, wait for every bridged call the turn started, and
 * fold the bridge's records into the turn's items.
 */
export async function runTurn<TContext, I, O>(params: {
  step: StepAcpAgent<TContext, I, O>;
  baseCtx: Context<ContextData>;
  session: AcpSession;
  beforePrompt(): Promise<void>;
  beforeCollect(): Promise<void> | undefined;
  collectId?: string;
  promptId?: string;
  recovery?: 'reattach' | 'unavailable';
  collectRequired: boolean;
  bridge: AcpEventBridge;
  tools: AcpToolRunner | undefined;
  turnError: TurnError;
  content: AcpContentBlock[];
  onPrompt?: (content: AcpContentBlock[]) => void;
  /**
   * Collect the turn an earlier host left running on a reattached session
   * before prompting; prompt only when no turn was running.
   */
  collect?: boolean;
}): Promise<AcpTurnResult> {
  const { step, baseCtx, session, bridge, tools, turnError } = params;
  if (tools) {
    bridge.nameToolCalls(
      (title: string) => tools.wireNameOf(title),
      (wireName, input) => tools.identityOf(wireName, input),
    );
  }
  bridge.begin();
  bridge.announceSettings(session);
  const cancelChild = session.cancelChild?.bind(session);
  if (cancelChild) {
    bridge.offerChildStops(cancelChild);
  }
  let result: AcpTurnResult;
  let sent = false;
  try {
    // Per-turn signal, so a session reused across turns is cancelled by the
    // context running the CURRENT turn rather than the one that opened it.
    const signal = abortSignalOf(baseCtx);
    if (params.collect) {
      await params.beforeCollect();
    }
    sent = params.collect === true;
    const collected =
      params.collect && session.resumeTurn
        ? await session.resumeTurn({
            signal,
            promptId: params.collectId,
          })
        : undefined;
    if (collected) {
      if (params.collectId !== undefined && collected.promptId !== params.collectId) {
        throw new NoeticErrorImpl({
          kind: 'acp_outcome_unknown',
          stepId: step.id,
          sessionId: session.sessionId,
        });
      }
      result = collected;
    } else {
      if (params.collectRequired && params.collect) {
        throw new NoeticErrorImpl({
          kind: 'acp_outcome_unknown',
          stepId: step.id,
          sessionId: session.sessionId,
        });
      }
      sent = false;
      await params.beforePrompt();
      if (!signal?.aborted) {
        params.onPrompt?.(params.content);
      }
      sent = true;
      result = await session.prompt({
        content: params.content,
        promptId: params.promptId,
        signal,
      });
    }
  } catch (e) {
    bridge.withdrawChildStops();
    const failure = sent
      ? promptFailure({
          step,
          ctx: baseCtx,
          session,
          cause: turnError.error ?? e,
          recovery: params.recovery,
        })
      : stepFailure(step, turnError.error ?? e, baseCtx);
    if (
      baseCtx.abortReason === TURN_CUT_ABORT ||
      (isNoeticError(failure) && failure.noeticError.kind === 'acp_link_lost')
    ) {
      // Calls still waiting on the old host must not block a new attachment.
      tools?.unbind();
      baseCtx.abort(TURN_CUT_ABORT);
    } else {
      await settle(tools);
      tools?.takeFinished();
    }
    bridge.abort(failure);
    throw failure;
  }
  // The agent answered: its turn is over, whatever its bridged calls still do.
  bridge.withdrawChildStops();
  await settle(tools);
  if (turnError.error !== undefined) {
    tools?.takeFinished();
    const failure = promptFailure({
      step,
      ctx: baseCtx,
      session,
      cause: turnError.error,
    });
    bridge.abort(failure);
    throw failure;
  }
  if (tools) {
    const merged = mergeBridgedItems(result.items, tools.takeFinished());
    result = {
      ...result,
      items: merged.items,
    };
  }
  bridge.finalize(result);
  return result;
}

/** A failure after dispatch leaves the agent's effects in doubt. */
function promptFailure({
  step,
  ctx,
  session,
  cause,
  recovery,
}: {
  step: {
    id: string;
  };
  ctx: Context<ContextData>;
  session: AcpSession;
  cause: unknown;
  recovery?: 'reattach' | 'unavailable';
}): NoeticErrorImpl | NoeticConfigError {
  const failure = stepFailure(step, cause, ctx);
  const ending = turnEndingIn(failure);
  if (ending) {
    return ending;
  }
  if (!isNoeticError(failure) || failure.noeticError.kind === 'cancelled' || ctx.aborted) {
    return failure;
  }
  if (recovery === 'reattach' && isAcpConnectError(cause) && !cause.gone) {
    return new NoeticErrorImpl({
      kind: 'acp_link_lost',
      stepId: step.id,
      cause,
    });
  }
  return new NoeticErrorImpl({
    kind: 'acp_outcome_unknown',
    stepId: step.id,
    sessionId: session.sessionId,
  });
}

/** Let every bridged call the turn started finish, then stop taking calls. */
async function settle(tools: AcpToolRunner | undefined): Promise<void> {
  if (!tools) {
    return;
  }
  await tools.idle();
  tools.unbind();
}

export async function stepOutput<TContext, I, O>(
  step: StepAcpAgent<TContext, I, O>,
  result: AcpTurnResult,
): Promise<O> {
  const lastText = result.text.trim().length > 0 ? result.text : extractAssistantText(result.items);
  if (step.output) {
    return await parseStructuredOutput<O>({
      schema: step.output,
      rawText: lastText,
      stepId: step.id,
    });
  }
  return frameworkCast<O>(lastText);
}

//#endregion
