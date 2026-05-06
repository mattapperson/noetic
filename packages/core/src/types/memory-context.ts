import type { LLMResponse } from './common';
import type { FsAdapter } from './fs-adapter';
import type { Item } from './items';
import type { ShellAdapter } from './shell-adapter';

/** @public Isolation scope controlling how a memory layer's state is keyed and shared. */
export type MemoryScope = 'thread' | 'resource' | 'global' | 'execution';

/** @public Terminal outcome of an execution run, reported to memory layers on completion. */
export type ExecutionOutcome = 'success' | 'failure' | 'aborted';

/** @public Minimal model-call surface exposed to memory-layer hooks. */
export interface MemoryCallModelRequest {
  model: string;
  items: ReadonlyArray<Item>;
  instructions?: string;
}

/** @public Runtime metadata available to memory layer hooks during each lifecycle phase. */
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
  callModel?: (request: MemoryCallModelRequest) => Promise<LLMResponse>;
  tokenize(text: string): number;
  trace: {
    setAttribute(key: string, value: string | number | boolean): void;
    addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  };
  /** Snapshot a sibling memory layer's state by its `layer.id`. */
  readLayerState<T>(layerId: string): T | undefined;
}
