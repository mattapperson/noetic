import type { LLMResponse } from './common';
import type { ExecutionContext, MemoryScope } from './memory-context';

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
  durationMs?: number;
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
  scope?: MemoryScope;
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
