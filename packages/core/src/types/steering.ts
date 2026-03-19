import type { CallModelFn } from '../interpreter/execute-llm';
import type { LLMResponse } from './common';
import type { ExecutionContext, MemoryScope } from './memory';

//#region Enums

export const SteeringAction = {
  Allow: 'allow',
  Deny: 'deny',
  Guide: 'guide',
} as const;

export type SteeringAction = (typeof SteeringAction)[keyof typeof SteeringAction];

export const LedgerEntryKind = {
  ToolCall: 'tool_call',
  ModelTurn: 'model_turn',
  Custom: 'custom',
} as const;

export type LedgerEntryKind = (typeof LedgerEntryKind)[keyof typeof LedgerEntryKind];

//#endregion

//#region Types

export interface SteeringDecision {
  action: SteeringAction;
  guidance?: string;
}

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

export interface BeforeToolCallParams<TState = unknown> {
  toolName: string;
  toolArgs: unknown;
  ctx: ExecutionContext;
  state: TState;
}

export interface BeforeToolCallResult<TState = unknown> {
  decision: SteeringDecision;
  state?: TState;
}

export interface AfterModelCallParams<TState = unknown> {
  response: LLMResponse;
  ctx: ExecutionContext;
  state: TState;
}

export interface AfterModelCallResult<TState = unknown> {
  decision: SteeringDecision;
  state?: TState;
}

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

export interface SteeringConfig {
  rules: SteeringRule[];
  maxLedgerEntries?: number;
  maxRetries?: number;
  scope?: MemoryScope;
  callModel?: CallModelFn;
}

export interface SteeringState {
  ledger: LedgerEntry[];
  pendingAsync: Array<{
    ruleId: string;
    guidance: string;
  }>;
}

//#endregion
