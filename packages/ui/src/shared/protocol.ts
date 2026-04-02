/**
 * Shared WebSocket protocol types for Noetic UI
 *
 * Defines the message types exchanged between the UI server and clients
 * via WebSocket connections.
 */

import { z } from 'zod';

// ============================================================================
// Zod Schemas for Runtime Validation
// ============================================================================

const baseMessageSchema = z.object({
  type: z.string(),
});

const serverMessageTypes = z.enum([
  'execution.start',
  'node.start',
  'node.complete',
  'node.error',
  'node.pause',
  'node.resume',
  'node.data',
  'execution.complete',
  'execution.error',
  'pong',
]);

const clientMessageTypes = z.enum([
  'execution.list',
  'execution.get',
  'execution.replay',
  'node.stepOver',
  'node.stepInto',
  'node.stepOut',
  'node.resume',
  'breakpoint.add',
  'breakpoint.remove',
  'ping',
  // Agent -> Server messages
  'agent.register',
  'trace.start',
  'trace.nodeStart',
  'trace.nodeComplete',
  'trace.nodeError',
  'trace.complete',
  'trace.error',
]);

// ============================================================================
// Core Types
// ============================================================================

export type StepKind = 'run' | 'llm' | 'tool' | 'branch' | 'fork' | 'spawn' | 'loop';

export type NodeStatus = 'pending' | 'running' | 'paused' | 'completed' | 'error' | 'cancelled';

export type RunStatus = 'running' | 'completed' | 'error' | 'paused' | 'cancelled';

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export interface NoeticError {
  message: string;
  code?: string;
  stack?: string;
}

export interface ContextSnapshot {
  depth: number;
  stepCount: number;
  tokens: TokenUsage;
  cost: number;
  elapsedMs: number;
  state: unknown;
  itemLogLength: number;
}

export interface MessageItem {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface FunctionCallItem {
  name: string;
  arguments: Record<string, unknown>;
}

// ============================================================================
// Step Data Types
// ============================================================================

export interface LLMStepData {
  model: string;
  messages: MessageItem[];
  toolCalls: FunctionCallItem[];
  tokenUsage: TokenUsage;
  cost: number;
}

export interface ToolStepData {
  toolName: string;
  arguments: unknown;
  result: unknown;
}

export interface ForkStepData {
  mode: 'race' | 'all' | 'settle';
  pathCount: number;
  winnerPath?: number;
}

export type StepData = LLMStepData | ToolStepData | ForkStepData | Record<string, unknown>; // For other step types

// ============================================================================
// Execution Node
// ============================================================================

export interface ExecutionNode {
  id: string;
  stepId: string;
  kind: StepKind;
  parentId: string | null;
  depth: number;

  // Timing
  startTime: number;
  endTime: number | null;
  durationMs: number | null;

  // Status
  status: NodeStatus;
  error?: NoeticError;

  // Data
  input: unknown;
  output: unknown | null;
  contextSnapshot: ContextSnapshot;

  // Step-specific data
  stepData: StepData;

  // Relationships
  children: string[];
  forkPaths?: string[][];
}

// ============================================================================
// Execution Trace
// ============================================================================

export interface ExecutionTrace {
  traceId: string;
  rootStepId: string;
  startTime: number;
  endTime: number | null;
  status: RunStatus;
  nodes: Map<string, ExecutionNode>;
  rootNodeId: string;
}

export interface ExecutionSummary {
  traceId: string;
  totalNodes: number;
  completedNodes: number;
  errorNodes: number;
  durationMs: number;
  totalTokens: TokenUsage;
  totalCost: number;
}

export interface PausePoint {
  timestamp: number;
  nodeId: string;
  action: 'pause' | 'resume';
  reason?: string;
}

export interface TimelineEvent {
  timestamp: number;
  nodeId: string;
  type: 'start' | 'complete' | 'error' | 'pause' | 'data';
  data?: unknown;
}

export interface Run {
  id: string;
  agentId: string;

  // Timing
  startTime: number;
  endTime: number | null;
  durationMs: number | null;

  // Status
  status: RunStatus;

  // Input
  input: unknown;
  inputPreview: string;

  // Execution data
  trace: ExecutionTrace;
  rootNodeId: string;

  // Timeline data
  timelineEvents: TimelineEvent[];
  currentTimelinePosition: number;

  // Aggregated metrics
  totalSteps: number;
  totalTokens: TokenUsage;
  totalCost: number;
  maxDepth: number;

  // Memory tracking
  memoryBytes: number;
  maxMemoryBytes: number;

  // Recording metadata
  recordingVersion: string;
  isLive: boolean;

  // Debugging
  breakpointsHit: string[];
  pauseHistory: PausePoint[];
}

// ============================================================================
// Server -> Client Messages
// ============================================================================

export interface ExecutionStartMessage {
  type: 'execution.start';
  agentId: string;
  trace: ExecutionTrace;
}

export interface NodeStartMessage {
  type: 'node.start';
  node: ExecutionNode;
}

export interface NodeCompleteMessage {
  type: 'node.complete';
  nodeId: string;
  output: unknown;
  durationMs: number;
}

export interface NodeErrorMessage {
  type: 'node.error';
  nodeId: string;
  error: NoeticError;
}

export interface NodePauseMessage {
  type: 'node.pause';
  nodeId: string;
  reason: 'breakpoint' | 'step' | 'error';
}

export interface NodeResumeServerMessage {
  type: 'node.resume';
  traceId: string;
  nodeId: string;
}

export interface NodeDataMessage {
  type: 'node.data';
  nodeId: string;
  data: Partial<ExecutionNode>;
}

export interface ExecutionCompleteMessage {
  type: 'execution.complete';
  agentId: string;
  traceId: string;
  summary: ExecutionSummary;
}

export interface ExecutionErrorMessage {
  type: 'execution.error';
  agentId: string;
  traceId: string;
  error: NoeticError;
}

export interface PongMessage {
  type: 'pong';
  timestamp: number;
}

// ============================================================================
// Agent -> Server Messages (for TraceExporter)
// ============================================================================

export interface AgentRegisterMessage {
  type: 'agent.register';
  agentId: string;
  agentName: string;
  timestamp: number;
}

export interface TraceStartMessage {
  type: 'trace.start';
  traceId: string;
  agentId: string;
  input: unknown;
  startTime: number;
}

export interface TraceNodeStartMessage {
  type: 'trace.nodeStart';
  traceId: string;
  node: ExecutionNode;
}

export interface TraceNodeCompleteMessage {
  type: 'trace.nodeComplete';
  traceId: string;
  nodeId: string;
  output: unknown;
  durationMs: number;
}

export interface TraceNodeErrorMessage {
  type: 'trace.nodeError';
  traceId: string;
  nodeId: string;
  error: NoeticError;
}

export interface TraceCompleteMessage {
  type: 'trace.complete';
  traceId: string;
  summary: ExecutionSummary;
  endTime: number;
}

export interface TraceErrorMessage {
  type: 'trace.error';
  traceId: string;
  error: NoeticError;
  endTime: number;
}

export type ServerMessage =
  | ExecutionStartMessage
  | NodeStartMessage
  | NodeCompleteMessage
  | NodeErrorMessage
  | NodePauseMessage
  | NodeResumeServerMessage
  | NodeDataMessage
  | ExecutionCompleteMessage
  | ExecutionErrorMessage
  | PongMessage;

// ============================================================================
// Client -> Server Messages
// ============================================================================

export interface ExecutionListMessage {
  type: 'execution.list';
}

export interface ExecutionGetMessage {
  type: 'execution.get';
  traceId: string;
}

export interface ExecutionReplayMessage {
  type: 'execution.replay';
  traceId: string;
  fromNodeId?: string;
}

export interface NodeStepOverMessage {
  type: 'node.stepOver';
  traceId: string;
  nodeId: string;
}

export interface NodeStepIntoMessage {
  type: 'node.stepInto';
  traceId: string;
  nodeId: string;
}

export interface NodeStepOutMessage {
  type: 'node.stepOut';
  traceId: string;
  nodeId: string;
}

export interface NodeResumeMessage {
  type: 'node.resume';
  traceId: string;
  nodeId: string;
}

export interface BreakpointAddMessage {
  type: 'breakpoint.add';
  stepId: string;
  condition?: string;
}

export interface BreakpointRemoveMessage {
  type: 'breakpoint.remove';
  stepId: string;
}

export interface PingMessage {
  type: 'ping';
  timestamp: number;
}

export type ClientMessage =
  | ExecutionListMessage
  | ExecutionGetMessage
  | ExecutionReplayMessage
  | NodeStepOverMessage
  | NodeStepIntoMessage
  | NodeStepOutMessage
  | NodeResumeMessage
  | BreakpointAddMessage
  | BreakpointRemoveMessage
  | PingMessage
  // Agent -> Server messages
  | AgentRegisterMessage
  | TraceStartMessage
  | TraceNodeStartMessage
  | TraceNodeCompleteMessage
  | TraceNodeErrorMessage
  | TraceCompleteMessage
  | TraceErrorMessage;

// ============================================================================
// Protocol Helpers
// ============================================================================

export function isServerMessage(msg: unknown): msg is ServerMessage {
  const result = baseMessageSchema.safeParse(msg);
  if (!result.success) {
    return false;
  }
  return serverMessageTypes.safeParse(result.data.type).success;
}

export function isClientMessage(msg: unknown): msg is ClientMessage {
  const result = baseMessageSchema.safeParse(msg);
  if (!result.success) {
    return false;
  }
  return clientMessageTypes.safeParse(result.data.type).success;
}
