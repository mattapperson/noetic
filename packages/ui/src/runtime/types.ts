/**
 * @noetic/ui Runtime Types
 *
 * Type definitions for the Noetic UI runtime integration.
 * These types support the debug harness and trace export functionality.
 */

import type { Context, Step } from '@noetic/core';

/** Step kinds supported by the UI visualization */
export type StepKind = 'run' | 'llm' | 'tool' | 'branch' | 'fork' | 'spawn' | 'loop';

/** Execution status for nodes in the debug UI */
export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled';

/** Token usage tracking */
export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cached?: number;
}

/** Context snapshot at a point in time */
export interface ContextSnapshot {
  depth: number;
  stepCount: number;
  tokens: TokenUsage;
  cost: number;
  elapsedMs: number;
  state: unknown;
  itemLogLength: number;
}

/** Step-specific data for different step kinds */
export interface LLMStepData {
  model: string;
  messages: unknown[];
  toolCalls: unknown[];
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

export type StepData = LLMStepData | ToolStepData | ForkStepData | Record<string, unknown>;

/** Single execution node in the trace */
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
  status: ExecutionStatus;
  error?: {
    message: string;
    stack?: string;
  };

  // Data
  input: unknown;
  output: unknown | null;
  contextSnapshot: ContextSnapshot;
  stepData: StepData;

  // Relationships
  children: string[];
  forkPaths?: string[][];
}

/** Full execution trace for a run */
export interface ExecutionTrace {
  traceId: string;
  rootStepId: string;
  startTime: number;
  endTime: number | null;
  status: 'running' | 'completed' | 'error' | 'cancelled';
  nodes: Map<string, ExecutionNode>;
  rootNodeId: string;
}

/** Timeline event for playback scrubbing */
export interface TimelineEvent {
  timestamp: number;
  nodeId: string;
  type: 'start' | 'complete' | 'error' | 'pause' | 'resume';
}

/** Pause/resume history entry */
export interface PausePoint {
  timestamp: number;
  nodeId: string;
  reason: 'breakpoint' | 'step' | 'error' | 'manual';
  resumedAt?: number;
}

/** Complete run record */
export interface Run {
  id: string;
  agentId: string;

  // Timing
  startTime: number;
  endTime: number | null;
  durationMs: number | null;

  // Status
  status: 'running' | 'completed' | 'error' | 'paused' | 'cancelled';

  // Input
  input: unknown;
  inputPreview: string;

  // Execution data
  trace: ExecutionTrace;
  rootNodeId: string;

  // Timeline
  timelineEvents: TimelineEvent[];
  currentTimelinePosition: number;

  // Metrics
  totalSteps: number;
  totalTokens: TokenUsage;
  totalCost: number;
  maxDepth: number;

  // Memory
  memoryBytes: number;
  maxMemoryBytes: number;

  // Metadata
  recordingVersion: string;
  isLive: boolean;

  // Debugging
  breakpointsHit: string[];
  pauseHistory: PausePoint[];
}

/** Breakpoint configuration */
export interface Breakpoint {
  stepId: string;
  condition?: string;
}

/** Debugger configuration options */
export interface DebuggerConfig {
  /** Breakpoints to pause at */
  breakpoints?: (Breakpoint | string)[];
  /** Whether to pause when an error occurs */
  pauseOnError?: boolean;
  /** Whether to pause on spawn steps */
  pauseOnSpawn?: boolean;
  /** Auto-start execution (if false, waits for UI signal) */
  autoStart?: boolean;
}

/** WebSocket message types from server to client */
export type ServerMessage =
  | {
      type: 'execution.start';
      trace: ExecutionTrace;
    }
  | {
      type: 'node.start';
      node: ExecutionNode;
    }
  | {
      type: 'node.complete';
      nodeId: string;
      output: unknown;
      durationMs: number;
    }
  | {
      type: 'node.error';
      nodeId: string;
      error: {
        message: string;
        stack?: string;
      };
    }
  | {
      type: 'node.pause';
      nodeId: string;
      reason: 'breakpoint' | 'step' | 'error' | 'manual';
    }
  | {
      type: 'node.resume';
      traceId: string;
      nodeId: string;
    }
  | {
      type: 'node.data';
      nodeId: string;
      data: Partial<ExecutionNode>;
    }
  | {
      type: 'execution.complete';
      traceId: string;
      summary: {
        totalSteps: number;
        durationMs: number;
      };
    }
  | {
      type: 'execution.error';
      traceId: string;
      error: {
        message: string;
        stack?: string;
      };
    }
  | {
      type: 'pong';
      timestamp: number;
    };

/** WebSocket message types from client to server */
export type ClientMessage =
  | {
      type: 'execution.list';
    }
  | {
      type: 'execution.get';
      traceId: string;
    }
  | {
      type: 'execution.replay';
      traceId: string;
      fromNodeId?: string;
    }
  | {
      type: 'node.stepOver';
      traceId: string;
      nodeId: string;
    }
  | {
      type: 'node.stepInto';
      traceId: string;
      nodeId: string;
    }
  | {
      type: 'node.stepOut';
      traceId: string;
      nodeId: string;
    }
  | {
      type: 'node.resume';
      traceId: string;
      nodeId: string;
    }
  | {
      type: 'breakpoint.add';
      stepId: string;
      condition?: string;
    }
  | {
      type: 'breakpoint.remove';
      stepId: string;
    }
  | {
      type: 'ping';
      timestamp: number;
    };

/** Exporter options for WebSocket connection */
export interface ExporterOptions {
  /** WebSocket server port */
  port?: number;
  /** WebSocket server host */
  host?: string;
  /** Max events to buffer before dropping */
  bufferSize?: number;
  /** How often to flush events (ms) */
  flushIntervalMs?: number;
  /** Auto-reconnect enabled */
  autoReconnect?: boolean;
}

/** Hook registration for step events */
export interface HookRegistration {
  /** Called when a step starts executing */
  onStepStart: (step: Step, input: unknown, ctx: Context) => Promise<void>;
  /** Called when a step completes */
  onStepComplete: (step: Step, result: unknown, ctx: Context) => Promise<void>;
  /** Called when a step errors */
  onStepError: (step: Step, error: Error, ctx: Context) => Promise<void>;
}

/** Debugger state and control interface */
export interface DebuggerState {
  /** Whether debugger is attached and active */
  isAttached: boolean;
  /** Currently executing run */
  currentRun: Run | null;
  /** Whether execution is paused */
  isPaused: boolean;
  /** Currently paused node */
  pausedNodeId: string | null;
  /** Breakpoints set for this run */
  breakpoints: Breakpoint[];
  /** IDs of breakpoints that have been hit during this run */
  breakpointsHit: string[];
  /** Pause history */
  pauseHistory: PausePoint[];
}

/** Debug controller interface for external control */
export interface DebugController {
  /** Pause execution at current step */
  pause(): void;
  /** Resume execution */
  resume(): void;
  /** Step over current step */
  stepOver(): void;
  /** Step into child steps */
  stepInto(): void;
  /** Step out of current context */
  stepOut(): void;
  /** Add a breakpoint */
  addBreakpoint(breakpoint: Breakpoint): void;
  /** Remove a breakpoint */
  removeBreakpoint(stepId: string): void;
}

/** Serializable span data for export */
export interface SerializableSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, string | number | boolean>;
  events: Array<{
    name: string;
    timestamp: number;
    attributes?: Record<string, string | number | boolean>;
  }>;
  duration: number;
}
