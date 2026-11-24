import type { LLMResponse } from './common';
import type { FsAdapter } from './fs-adapter';
import type { Item } from './items';
import type { ShellAdapter } from './shell-adapter';
import type { SteeringDecision } from './steering';

/** @public Isolation scope controlling how a context layer's state is keyed and shared. */
export type ContextScope = 'thread' | 'resource' | 'global' | 'execution';

/** @public Terminal outcome of an execution run, reported to context layers on completion. */
export type ExecutionOutcome = 'success' | 'failure' | 'aborted';

/** @public Minimal model-call surface exposed to context-layer hooks. */
export interface LayerCallModelRequest {
  model: string;
  items: ReadonlyArray<Item>;
  instructions?: string;
}

/**
 * @public Span opened from an `ExecutionContext`. `end()` closes the span and
 * hands it to the harness's trace exporter; await it so the export finishes.
 */
export interface ExecutionSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  end(): Promise<void>;
}

/** @public Runtime metadata available to context layer hooks during each lifecycle phase. */
export interface ExecutionContext {
  executionId: string;
  threadId: string;
  resourceId?: string;
  depth: number;
  stepNumber: number;
  tokenUsage: {
    input: number;
    output: number;
  };
  cost: number;
  /** Filesystem adapter for virtual or real filesystem access. */
  fs: FsAdapter;
  /** Shell adapter for virtual or real shell command execution. */
  shell: ShellAdapter;
  callModel?: (request: LayerCallModelRequest) => Promise<LLMResponse>;
  /**
   * Ask the harness's approval seam about an action (spec 08 § Held tool calls).
   * Resolves the settled decision; waits while the action is held for a person.
   * Absent on a harness with no approval seam.
   */
  approve?: (request: {
    toolName: string;
    toolArgs: unknown;
    callId: string;
    /** False when the turn must stay live while the action is held. Default true. */
    park?: boolean;
  }) => Promise<SteeringDecision>;
  tokenize(text: string): number;
  trace: {
    setAttribute(key: string, value: string | number | boolean): void;
    addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
    /**
     * Opens a span under the context's span. Optional: a context with no span
     * tree to grow omits it, and callers fall back to `addEvent`.
     */
    createSpan?(name: string): ExecutionSpan;
  };
  /** Snapshot a sibling context layer's state by its `layer.id`. */
  readLayerState<T>(layerId: string): T | undefined;
}
