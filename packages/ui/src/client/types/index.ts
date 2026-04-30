/**
 * Client-side types for Noetic UI
 * Based on spec sections from 21-noetic-ui.md
 */

export type StepKind = 'run' | 'llm' | 'tool' | 'branch' | 'fork' | 'spawn' | 'loop' | 'every';

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
  | EveryStepData
  | RunStepData;

export interface LLMStepData {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
  }>;
  /** All messages included in the LLM request payload (full conversation history). */
  payloadMessages: unknown[];
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

export interface EveryStepData {
  /** Park duration between iterations (ms). */
  ms: number;
  /** Random jitter applied to the park duration (ms). */
  jitter: number;
  /** Behavior when body throws: continue (default) or fail. */
  onError: 'continue' | 'fail';
  /** Body step id. */
  bodyStepId: string;
  /** Body step kind. */
  bodyStepKind: StepKind;
  /** Optional channel name that wakes the parking interval. */
  wakeOn?: string;
  /** Number of completed iterations so far (derived from child span count). */
  iteration?: number;
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
  return (
    data !== undefined &&
    'iteration' in data &&
    typeof data.iteration === 'number' &&
    'maxIterations' in data
  );
}

export function isEveryStepData(data: StepData | undefined): data is EveryStepData {
  return (
    data !== undefined &&
    'ms' in data &&
    typeof data.ms === 'number' &&
    'bodyStepId' in data &&
    typeof data.bodyStepId === 'string'
  );
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
  /** If true, this node is a container (loop/fork/branch/spawn) rendered as a bounding box */
  isContainer?: boolean;
  /** Scale factor relative to base size (1 = full, 0.5 = half, etc). Defaults to 1. */
  scale?: number;
}

export interface NodeEdge {
  id: string;
  source: string;
  target: string;
  type: 'default' | 'conditional' | 'fork' | 'loop' | 'spawn';
  animated?: boolean;
}

export interface Waypoint {
  x: number;
  y: number;
}

export interface OrthogonalEdge {
  /** Ordered waypoints forming the polyline (all grid-snapped) */
  waypoints: Waypoint[];
  /** The edge metadata this route was computed for */
  edgeId: string;
}
