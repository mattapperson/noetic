import type { LLMResponse } from './common';
import type { Context } from './context';
import type { ContextLayer } from './context-layer';
import type { DecideRequest, DecideResponse, DecisionRecord } from './decide';
import type { SteeringDecision } from './steering';

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
}
