/**
 * @noetic/ui Debugger
 *
 * Debug runtime with pause/resume functionality and breakpoint support.
 * Provides external control over agent execution for debugging purposes.
 */

import type { Context, Step } from '@noetic/core';
import type {
  Breakpoint,
  DebugController,
  DebuggerConfig,
  DebuggerState,
  ExecutionNode,
  ExecutionTrace,
  PausePoint,
  Run,
  ServerMessage,
  TimelineEvent,
} from './types';

/**
 * Debugger class for controlling execution with breakpoints and pause/resume
 *
 * This class manages the debug state for a single run, tracking:
 * - Current execution position
 * - Breakpoints and their evaluation
 * - Pause/resume state with async coordination
 * - Execution history for time-travel debugging
 */
export class Debugger implements DebugController {
  private config: Required<DebuggerConfig>;
  private state: DebuggerState;
  private trace: ExecutionTrace | null = null;
  private nodes = new Map<string, ExecutionNode>();
  private timelineEvents: TimelineEvent[] = [];
  private pauseResolvers = new Map<string, () => void>();
  private onEvent: ((message: ServerMessage) => void) | null = null;
  private startTime = 0;
  private stepCounter = 0;
  private parentStack: string[] = [];

  constructor(config: DebuggerConfig = {}, onEvent?: (message: ServerMessage) => void) {
    this.config = {
      breakpoints: [],
      pauseOnError: true,
      pauseOnSpawn: false,
      autoStart: true,
      ...config,
    };

    this.state = {
      isAttached: true,
      currentRun: null,
      isPaused: false,
      pausedNodeId: null,
      breakpoints: this.normalizeBreakpoints(this.config.breakpoints),
      breakpointsHit: [],
      pauseHistory: [],
    };

    this.onEvent = onEvent ?? null;
  }

  /**
   * Start a new debug run
   */
  startRun(agentId: string, runId: string, input: unknown): void {
    this.startTime = Date.now();
    this.stepCounter = 0;
    this.parentStack = [];
    this.timelineEvents = [];
    this.nodes.clear();

    this.trace = {
      traceId: runId,
      rootStepId: 'root',
      startTime: this.startTime,
      endTime: null,
      status: 'running',
      nodes: this.nodes,
      rootNodeId: '',
    };

    const run: Run = {
      id: runId,
      agentId,
      startTime: this.startTime,
      endTime: null,
      durationMs: null,
      status: 'running',
      input,
      inputPreview: this.truncatePreview(input),
      trace: this.trace,
      rootNodeId: '',
      timelineEvents: this.timelineEvents,
      currentTimelinePosition: 0,
      totalSteps: 0,
      totalTokens: {
        input: 0,
        output: 0,
        total: 0,
      },
      totalCost: 0,
      maxDepth: 0,
      memoryBytes: 0,
      maxMemoryBytes: 0,
      recordingVersion: '1.0',
      isLive: true,
      breakpointsHit: [],
      pauseHistory: [],
    };

    this.state.currentRun = run;

    // Wait for auto-start signal if configured
    if (!this.config.autoStart) {
      this.state.isPaused = true;
    }

    this.emit({
      type: 'execution.start',
      trace: this.trace,
    });
  }

  /**
   * Called when a step starts executing
   * Checks for breakpoints and pauses if needed
   */
  async onStepStart(step: Step, input: unknown, ctx: Context): Promise<void> {
    if (!this.state.isAttached || !this.trace) {
      return;
    }

    // Check if we need to pause before starting
    if (this.state.isPaused && !this.config.autoStart) {
      await this.waitForResume();
    }

    this.stepCounter++;
    const nodeId = this.generateNodeId(step.id);
    const parentId = this.getCurrentParentId();
    const depth = this.parentStack.length;

    // Create context snapshot
    const contextSnapshot = this.captureContextSnapshot(ctx);

    // Create execution node
    const node: ExecutionNode = {
      id: nodeId,
      stepId: step.id,
      kind: step.kind,
      parentId,
      depth,
      startTime: Date.now(),
      endTime: null,
      durationMs: null,
      status: 'running',
      input,
      output: null,
      contextSnapshot,
      stepData: {},
      children: [],
    };

    this.nodes.set(nodeId, node);

    // Update parent-child relationships
    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent) {
        parent.children.push(nodeId);
      }
    }

    // Track as current parent for nested steps
    if (this.isContainerStep(step.kind)) {
      this.parentStack.push(nodeId);
    }

    // Record timeline event
    this.timelineEvents.push({
      timestamp: node.startTime,
      nodeId,
      type: 'start',
    });

    // Check for breakpoints
    const shouldPause = await this.checkBreakpoint(step, input, nodeId);
    if (shouldPause) {
      await this.pauseAtNode(nodeId, 'breakpoint');
    }

    // Check for spawn pause
    if (this.config.pauseOnSpawn && step.kind === 'spawn') {
      await this.pauseAtNode(nodeId, 'step');
    }

    // Update run stats
    if (this.state.currentRun) {
      this.state.currentRun.totalSteps = this.stepCounter;
      this.state.currentRun.maxDepth = Math.max(this.state.currentRun.maxDepth, depth);
    }

    this.emit({
      type: 'node.start',
      node,
    });
  }

  /**
   * Called when a step completes
   */
  async onStepComplete(step: Step, result: unknown, ctx: Context): Promise<void> {
    if (!this.state.isAttached) {
      return;
    }

    const nodeId = this.findNodeForStep(step.id);
    if (!nodeId) {
      return;
    }

    const node = this.nodes.get(nodeId);
    if (!node) {
      return;
    }

    // Update node
    node.endTime = Date.now();
    node.durationMs = node.endTime - node.startTime;
    node.status = 'completed';
    node.output = result;
    node.contextSnapshot = this.captureContextSnapshot(ctx);

    // Extract step-specific data
    node.stepData = this.extractStepData(step, result);

    // Pop from parent stack if container
    if (this.isContainerStep(step.kind)) {
      this.parentStack.pop();
    }

    // Record timeline event
    this.timelineEvents.push({
      timestamp: node.endTime,
      nodeId,
      type: 'complete',
    });

    this.emit({
      type: 'node.complete',
      nodeId,
      output: result,
      durationMs: node.durationMs,
    });
  }

  /**
   * Called when a step errors
   */
  async onStepError(step: Step, error: Error, ctx: Context): Promise<void> {
    if (!this.state.isAttached) {
      return;
    }

    const nodeId = this.findNodeForStep(step.id);
    if (!nodeId) {
      return;
    }

    const node = this.nodes.get(nodeId);
    if (!node) {
      return;
    }

    // Update node
    node.endTime = Date.now();
    node.durationMs = node.endTime - node.startTime;
    node.status = 'error';
    node.error = {
      message: error.message,
      stack: error.stack,
    };
    node.contextSnapshot = this.captureContextSnapshot(ctx);

    // Pop from parent stack if container
    if (this.isContainerStep(step.kind)) {
      this.parentStack.pop();
    }

    // Record timeline event
    this.timelineEvents.push({
      timestamp: node.endTime,
      nodeId,
      type: 'error',
    });

    // Update run status
    if (this.state.currentRun) {
      this.state.currentRun.status = 'error';
    }

    if (this.trace) {
      this.trace.status = 'error';
      this.trace.endTime = Date.now();
    }

    this.emit({
      type: 'node.error',
      nodeId,
      error: {
        message: error.message,
        stack: error.stack,
      },
    });

    // Pause on error if configured
    if (this.config.pauseOnError) {
      await this.pauseAtNode(nodeId, 'error');
    }
  }

  /**
   * Complete the current run
   */
  endRun(finalStatus: 'completed' | 'error' | 'cancelled' = 'completed'): void {
    if (!this.state.currentRun || !this.trace) {
      return;
    }

    const endTime = Date.now();

    this.state.currentRun.status = finalStatus;
    this.state.currentRun.endTime = endTime;
    this.state.currentRun.durationMs = endTime - this.startTime;
    this.state.currentRun.isLive = false;
    this.state.currentRun.timelineEvents = this.timelineEvents;

    this.trace.status = finalStatus;
    this.trace.endTime = endTime;

    if (finalStatus === 'completed') {
      const message: ServerMessage = {
        type: 'execution.complete',
        traceId: this.trace.traceId,
        summary: {
          totalSteps: this.stepCounter,
          durationMs: this.state.currentRun.durationMs ?? 0,
        },
      };
      this.emit(message);
    } else {
      const message: ServerMessage = {
        type: 'execution.error',
        traceId: this.trace.traceId,
        error: {
          message: 'Execution failed',
        },
      };
      this.emit(message);
    }

    this.state.isAttached = false;
  }

  // DebugController implementation

  pause(): void {
    if (!this.state.isPaused) {
      this.state.isPaused = true;
    }
  }

  resume(): void {
    if (this.state.isPaused) {
      this.state.isPaused = false;

      // Resolve all pending pause promises
      for (const resolver of this.pauseResolvers.values()) {
        resolver();
      }
      this.pauseResolvers.clear();

      // Record resume in history
      if (this.state.pausedNodeId) {
        const lastPause = this.state.pauseHistory[this.state.pauseHistory.length - 1];
        if (lastPause && !lastPause.resumedAt) {
          lastPause.resumedAt = Date.now();
        }

        this.emit({
          type: 'node.resume',
          traceId: this.trace?.traceId ?? '',
          nodeId: this.state.pausedNodeId,
        } satisfies ServerMessage);
      }

      this.state.pausedNodeId = null;
    }
  }

  stepOver(): void {
    // Implementation: mark to pause at next sibling
    this.resume();
  }

  stepInto(): void {
    // Implementation: allow entering child steps
    this.resume();
  }

  stepOut(): void {
    // Implementation: run until current context completes
    this.resume();
  }

  addBreakpoint(breakpoint: Breakpoint): void {
    const normalized =
      typeof breakpoint === 'string'
        ? {
            stepId: breakpoint,
          }
        : breakpoint;

    this.state.breakpoints.push(normalized);
  }

  removeBreakpoint(stepId: string): void {
    this.state.breakpoints = this.state.breakpoints.filter((bp) => bp.stepId !== stepId);
  }

  // Getters

  get isAttached(): boolean {
    return this.state.isAttached;
  }

  get isPaused(): boolean {
    return this.state.isPaused;
  }

  get currentRun(): Run | null {
    return this.state.currentRun;
  }

  get breakpoints(): Breakpoint[] {
    return [
      ...this.state.breakpoints,
    ];
  }

  get pauseHistory(): PausePoint[] {
    return [
      ...this.state.pauseHistory,
    ];
  }

  // Private helpers

  private normalizeBreakpoints(breakpoints: (Breakpoint | string)[]): Breakpoint[] {
    return breakpoints.map((bp) =>
      typeof bp === 'string'
        ? {
            stepId: bp,
          }
        : bp,
    );
  }

  private generateNodeId(stepId: string): string {
    return `${stepId}-${this.stepCounter}-${Date.now()}`;
  }

  private getCurrentParentId(): string | null {
    return this.parentStack.length > 0 ? this.parentStack[this.parentStack.length - 1] : null;
  }

  private isContainerStep(kind: string): boolean {
    return kind === 'spawn' || kind === 'loop' || kind === 'fork';
  }

  private findNodeForStep(stepId: string): string | null {
    // Find most recent running node for this step
    for (const [nodeId, node] of this.nodes) {
      if (node.stepId === stepId && node.status === 'running') {
        return nodeId;
      }
    }
    return null;
  }

  private async checkBreakpoint(step: Step, input: unknown, nodeId: string): Promise<boolean> {
    for (const breakpoint of this.state.breakpoints) {
      if (breakpoint.stepId === step.id) {
        // Check condition if present
        if (breakpoint.condition) {
          try {
            // Simple condition evaluation - in production, use a safe evaluator
            const shouldBreak = this.evaluateCondition(breakpoint.condition, input);
            if (shouldBreak) {
              this.state.breakpointsHit.push(nodeId);
              return true;
            }
          } catch (error) {
            // If condition evaluation fails, break anyway but log the error
            console.error(
              `[Debugger] Breakpoint condition evaluation failed for ${breakpoint.stepId}:`,
              error,
            );
            this.state.breakpointsHit.push(nodeId);
            return true;
          }
        } else {
          // No condition, always break
          this.state.breakpointsHit.push(nodeId);
          return true;
        }
      }
    }
    return false;
  }

  private evaluateCondition(condition: string, input: unknown): boolean {
    // Simple condition evaluation
    // In production, use a proper expression evaluator
    try {
      // Type guard for record input
      const isRecord = (val: unknown): val is Record<string, unknown> => {
        return typeof val === 'object' && val !== null && !Array.isArray(val);
      };

      if (!isRecord(input)) {
        return false;
      }

      // Handle simple comparison conditions like "input.attempt > 3"
      const match = condition.match(/(\w+)\s*(==|!=|>|<|>=|<=)\s*(.+)/);
      if (match) {
        const [, prop, operator, valueStr] = match;
        const propValue = input[prop];
        const value = JSON.parse(valueStr);

        switch (operator) {
          case '==':
            return propValue === value;
          case '!=':
            return propValue !== value;
          case '>':
            return Number(propValue) > value;
          case '<':
            return Number(propValue) < value;
          case '>=':
            return Number(propValue) >= value;
          case '<=':
            return Number(propValue) <= value;
        }
      }

      return false;
    } catch (error) {
      console.error('[Debugger] Failed to evaluate breakpoint condition:', condition, error);
      return false;
    }
  }

  private async pauseAtNode(nodeId: string, reason: PausePoint['reason']): Promise<void> {
    this.state.isPaused = true;
    this.state.pausedNodeId = nodeId;

    this.state.pauseHistory.push({
      timestamp: Date.now(),
      nodeId,
      reason,
    });

    this.emit({
      type: 'node.pause',
      nodeId,
      reason,
    });

    // Wait for resume
    await this.waitForResume();
  }

  private waitForResume(): Promise<void> {
    if (!this.state.isPaused) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      this.pauseResolvers.set(id, resolve);
    });
  }

  private captureContextSnapshot(ctx: Context): {
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
  } {
    return {
      depth: ctx.depth,
      stepCount: ctx.stepCount,
      tokens: {
        input: ctx.tokens?.input ?? 0,
        output: ctx.tokens?.output ?? 0,
        total: (ctx.tokens?.input ?? 0) + (ctx.tokens?.output ?? 0),
      },
      cost: ctx.cost ?? 0,
      elapsedMs: Date.now() - this.startTime,
      state: ctx.state,
      itemLogLength: ctx.itemLog?.length ?? 0,
    };
  }

  private extractStepData(step: Step, _result: unknown): Record<string, unknown> {
    const stepData: Record<string, unknown> = {};

    if (step.kind === 'llm') {
      stepData.model = step.model;
    } else if (step.kind === 'tool') {
      stepData.toolName = step.tool.name;
    } else if (step.kind === 'fork') {
      stepData.mode = step.mode;
    } else if (step.kind === 'spawn') {
      stepData.childId = step.child.id;
    } else if (step.kind === 'loop') {
      stepData.stepCount = step.steps.length;
    }

    return stepData;
  }

  private truncatePreview(input: unknown): string {
    const str = JSON.stringify(input);
    if (str.length <= 50) {
      return str;
    }
    return `${str.slice(0, 47)}...`;
  }

  private emit(message: ServerMessage): void {
    if (this.onEvent) {
      this.onEvent(message);
    }
  }
}
