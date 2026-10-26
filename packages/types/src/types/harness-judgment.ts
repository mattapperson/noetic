import type { LLMResponse } from './common';
import type { Context } from './context';
import type { ContextLayer } from './context-layer';
import type { DecideRequest, DecideResponse, DecisionRecord } from './decide';
import type { OnSteerParams, SteeringDecision, SteerVerdict } from './steering';

/**
 * @public The judgment calls an agent harness makes for a step: the steering
 * hooks around tool and model calls, and typed decisions. Part of
 * `AgentHarnessContract`.
 */
export interface HarnessJudgmentContract {
  /** Answer typed questions with a decision model, or estimate with a chat model. See spec 32. */
  decide(request: DecideRequest): Promise<DecideResponse>;
  /** Run every layer's `onDecision` hook, in slot order. */
  notifyDecision(layers: ContextLayer[], record: DecisionRecord, ctx: Context): Promise<void>;
  beforeToolCall(
    layers: ContextLayer[],
    toolName: string,
    toolArgs: unknown,
    ctx: Context,
    callId?: string,
  ): Promise<SteeringDecision>;
  afterModelCall(
    layers: ContextLayer[],
    response: LLMResponse,
    ctx: Context,
  ): Promise<SteeringDecision>;
  /** Run a steer through every layer's `onSteer` hook, in slot order. */
  onSteer(
    layers: ContextLayer[],
    params: Pick<OnSteerParams, 'steer' | 'point' | 'action' | 'pendingCalls'>,
    ctx: Context,
  ): Promise<SteerVerdict>;
}

/**
 * @public Parameters passed to the harness approver for a call to a tool that
 * declares `needsApproval`.
 */
export interface ApproveToolCallParams {
  toolName: string;
  /** The validated arguments — exactly what `execute` receives if the call is approved. */
  toolArgs: unknown;
  /** Correlation id of the pending call; see `BeforeToolCallParams.callId`. */
  callId?: string;
  /**
   * The calling step's context. An approver that waits on a human passes it
   * to `ctx.harness.send` / `ctx.harness.recv` to park on a channel.
   */
  ctx: Context;
}

/**
 * @public Decides whether a call to a tool that declares `needsApproval` may
 * run. Configured once per harness (`AgentHarness({ approveToolCall })`) and
 * consulted after every `beforeToolCall` layer has allowed the call. `allow`
 * runs the call; any other action refuses it, with `guidance` as the reason.
 * May be async and may wait — e.g. on a channel a human answers.
 */
export type ToolApprover = (
  params: ApproveToolCallParams,
) => SteeringDecision | Promise<SteeringDecision>;
