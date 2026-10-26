import type { LLMResponse } from './common';
import type { ContextScope, ExecutionContext } from './context-scope';
import type { FunctionCallItem, Item } from './items';

//#region Enums

/** @public Enumeration of actions a steering rule can take on a tool call or model response. */
export const SteeringAction = {
  Allow: 'allow',
  Deny: 'deny',
  Guide: 'guide',
} satisfies Record<string, string>;

export type SteeringAction = (typeof SteeringAction)[keyof typeof SteeringAction];

/** @public Discriminator for ledger entry types recorded during steering evaluation. */
export const LedgerEntryKind = {
  ToolCall: 'tool_call',
  ModelTurn: 'model_turn',
  Custom: 'custom',
} satisfies Record<string, string>;

export type LedgerEntryKind = (typeof LedgerEntryKind)[keyof typeof LedgerEntryKind];

/**
 * @public Where a running model call offers a steer to the context layers.
 *
 * - `item_done`: an output item just finished streaming. Applying here stops
 *   the stream, keeps the finished items, and starts the next round.
 * - `before_tool_call`: a tool call is about to run. Applying here skips this
 *   call and the rest of the round.
 * - `before_round`: the next model call is about to start, including the first.
 */
export const SteerPoint = {
  ItemDone: 'item_done',
  BeforeToolCall: 'before_tool_call',
  BeforeRound: 'before_round',
} satisfies Record<string, string>;

export type SteerPoint = (typeof SteerPoint)[keyof typeof SteerPoint];

/**
 * @public What happens to a steer at a steer point.
 *
 * - `apply`: add it to the conversation before the next model call.
 * - `defer`: leave it queued; it is offered again at the next point.
 * - `drop`: discard it. The harness emits `steer_dropped`.
 */
export const SteerAction = {
  Apply: 'apply',
  Defer: 'defer',
  Drop: 'drop',
} satisfies Record<string, string>;

export type SteerAction = (typeof SteerAction)[keyof typeof SteerAction];

//#endregion

//#region Types

/** @public Result of evaluating steering rules: an action and optional guidance message. */
export interface SteeringDecision {
  action: SteeringAction;
  guidance?: string;
}

/** @public A single entry in the steering ledger, recording a tool call, model turn, or custom event. */
export interface LedgerEntry {
  kind: LedgerEntryKind;
  timestamp: number;
  toolName?: string;
  toolArgs?: unknown;
  success?: boolean;
  /** Duration in milliseconds. */
  duration?: number;
  model?: string;
  tokenUsage?: {
    input: number;
    output: number;
  };
  custom?: Record<string, unknown>;
  ruleId?: string;
  action?: SteeringAction;
  guidance?: string;
}

/** @public Parameters passed to a steering rule's `beforeToolCall` evaluation. */
export interface BeforeToolCallParams<TState = unknown> {
  toolName: string;
  toolArgs: unknown;
  /**
   * Correlation id of the pending call — the same id carried by the
   * `tool_call_started` framework event (the model's `callId` on model-driven
   * calls, the step id on a direct `invokeTool`). Lets a gating layer tie its
   * decision to the call it is reported as, e.g. when forwarding the request
   * to an external approver. Optional because a custom caller of the gate may
   * have no call identity; every built-in tool-executing path supplies it.
   */
  callId?: string;
  ctx: ExecutionContext;
  state: TState;
}

/** @public Value returned by a `beforeToolCall` steering hook with a decision and optional state update. */
export interface BeforeToolCallResult<TState = unknown> {
  decision: SteeringDecision;
  state?: TState;
}

/** @public Parameters passed to a steering rule's `afterModelCall` evaluation. */
export interface AfterModelCallParams<TState = unknown> {
  response: LLMResponse;
  ctx: ExecutionContext;
  state: TState;
}

/** @public Value returned by an `afterModelCall` steering hook with a decision and optional state update. */
export interface AfterModelCallResult<TState = unknown> {
  decision: SteeringDecision;
  state?: TState;
}

/** @public A message sent into a running turn. */
export interface Steer {
  /** The `messageId` it was submitted with. */
  id: string;
  items: Item[];
}

/** @public Parameters passed to a layer's `onSteer` hook. */
export interface OnSteerParams<TState = unknown> {
  steer: Steer;
  point: SteerPoint;
  /**
   * The action so far: the delivery mode's default, as changed by layers in
   * earlier slots.
   */
  action: SteerAction;
  /** Tool calls from the current round that have not run yet. */
  pendingCalls: ReadonlyArray<FunctionCallItem>;
  ctx: ExecutionContext;
  state: TState;
}

/** @public Value returned by an `onSteer` hook. Omitted fields keep their current value. */
export interface OnSteerResult<TState = unknown> {
  action?: SteerAction;
  /** Replace what the model sees for this steer. */
  items?: Item[];
  /**
   * Run recall again once the steer is applied, so layers render context for the
   * conversation it changed. The model call ends at the next round boundary and
   * continues on the new view. Any layer asking is enough.
   */
  recall?: boolean;
  state?: TState;
}

/** @public The outcome of running a steer through every layer's `onSteer` hook. */
export interface SteerVerdict {
  action: SteerAction;
  items: Item[];
  recall?: boolean;
}

/** @public A named rule evaluated by the steering layer before tool calls or after model responses. */
export interface SteeringRule {
  id: string;
  name?: string;
  appliesTo: ('beforeToolCall' | 'afterModelCall')[];
  predicate?: (params: BeforeToolCallParams | AfterModelCallParams) => SteeringDecision;
  llmEval?: {
    mode: 'sync' | 'async';
    prompt: string;
    model?: string;
  };
}

/** @public Top-level configuration for the steering subsystem, including rules and limits. */
export interface SteeringConfig {
  rules: SteeringRule[];
  maxLedgerEntries?: number;
  maxRetries?: number;
  scope?: ContextScope;
}

/** @public Mutable runtime state maintained by the steering layer across an execution. */
export interface SteeringState {
  ledger: LedgerEntry[];
  pendingAsync: Array<{
    ruleId: string;
    guidance: string;
  }>;
}

//#endregion
