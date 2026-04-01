/**
 * Client-side types for Noetic UI
 * Based on spec sections from 21-noetic-ui.md
 */

export type StepKind = 'run' | 'llm' | 'tool' | 'branch' | 'fork' | 'spawn' | 'loop';

export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled';

export interface ExecutionNode {
  id: string;
  stepId: string;
  kind: StepKind;
  parentId: string | null;
  depth: number;
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  status: ExecutionStatus;
  error?: {
    message: string;
    code?: string;
  };
  input: unknown;
  output: unknown | null;
  contextSnapshot: ContextSnapshot;
  stepData: StepData;
  children: string[];
  forkPaths?: string[][];
  title?: string;
  attemptCount?: number;
}

export interface ContextSnapshot {
  depth: number;
  stepCount: number;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  cost: number;
  elapsedMs: number;
  state: unknown;
  itemLogLength: number;
}

export type StepData =
  | LLMStepData
  | ToolStepData
  | BranchStepData
  | ForkStepData
  | SpawnStepData
  | LoopStepData
  | RunStepData;

export interface LLMStepData {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
  }>;
  toolCalls: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
  cost: number;
}

export interface ToolStepData {
  toolName: string;
  arguments: unknown;
  result: unknown;
}

export interface BranchStepData {
  condition?: string;
  selectedPath?: number;
}

export interface ForkStepData {
  mode: 'race' | 'all' | 'settle';
  pathCount: number;
  winnerPath?: number;
}

export interface SpawnStepData {
  childStepId: string;
  childStepKind: StepKind;
}

export interface LoopStepData {
  iteration: number;
  totalIterations: number;
  maxIterations: number;
}

export interface RunStepData {
  description?: string;
}

// Type guard functions for safe type narrowing
export function isLLMStepData(data: StepData | undefined): data is LLMStepData {
  return data !== undefined && 'model' in data && typeof data.model === 'string';
}

export function isToolStepData(data: StepData | undefined): data is ToolStepData {
  return data !== undefined && 'toolName' in data && typeof data.toolName === 'string';
}

export function isBranchStepData(data: StepData | undefined): data is BranchStepData {
  return data !== undefined && ('condition' in data || 'selectedPath' in data);
}

export function isForkStepData(data: StepData | undefined): data is ForkStepData {
  if (data === undefined || !('mode' in data)) {
    return false;
  }
  const mode = data.mode;
  return mode === 'race' || mode === 'all' || mode === 'settle';
}

export function isSpawnStepData(data: StepData | undefined): data is SpawnStepData {
  return data !== undefined && 'childStepId' in data && typeof data.childStepId === 'string';
}

export function isLoopStepData(data: StepData | undefined): data is LoopStepData {
  return data !== undefined && 'iteration' in data && typeof data.iteration === 'number';
}

export function isRunStepData(data: StepData | undefined): data is RunStepData {
  return data !== undefined && 'description' in data && typeof data.description === 'string';
}

export interface ExecutionTrace {
  traceId: string;
  rootStepId: string;
  startTime: number;
  endTime: number | null;
  status: 'running' | 'completed' | 'error' | 'paused' | 'cancelled';
  nodes: Map<string, ExecutionNode>;
  rootNodeId: string;
}

export interface TimelineEvent {
  timestamp: number;
  nodeId: string;
  type: 'start' | 'complete' | 'error' | 'pause';
  stepKind: StepKind;
  depth: number;
}

export interface NodePosition {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NodeEdge {
  id: string;
  source: string;
  target: string;
  type: 'default' | 'conditional' | 'fork' | 'loop';
  animated?: boolean;
}
