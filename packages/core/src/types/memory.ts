import type { LLMResponse } from './common';
import type { ItemLog } from './context';
import type { Item } from './items';

// Slot constants
export const Slot = {
  WORKING_MEMORY: 100,
  ENTITY: 150,
  OBSERVATIONS: 200,
  PROCEDURAL: 250,
  EPISODIC: 300,
  RAG: 350,
  SEMANTIC_RECALL: 400,
} as const;

export type MemoryScope = 'thread' | 'resource' | 'global' | 'execution';

export type BudgetConfig =
  | number
  | {
      min: number;
      max: number;
    }
  | 'auto';

export interface LayerTimeouts {
  init?: number;
  recall?: number;
  store?: number;
  onSpawn?: number;
  onReturn?: number;
  onComplete?: number;
  dispose?: number;
}

export type ExecutionOutcome = 'success' | 'failure' | 'aborted';

// Execution context available to memory layers
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
  model?: string;
  tokenize(text: string): number;
  trace: {
    setAttribute(key: string, value: string | number | boolean): void;
    addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  };
}

// Storage interfaces
export interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface ScopedStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

// Hook parameter types
export interface InitParams {
  storage: ScopedStorage;
  scopeKey: string;
  ctx: ExecutionContext;
}

export interface InitResult<TState> {
  state: TState;
}

export interface RecallParams<TState> {
  log: ItemLog;
  query: string;
  ctx: ExecutionContext;
  state: TState;
  budget: number;
}

export interface RecallResult<TState = unknown> {
  items: Item[];
  tokenCount: number;
  state?: TState;
}

export interface StoreParams<TState> {
  newItems: Item[];
  log: ItemLog;
  response: LLMResponse;
  ctx: ExecutionContext;
  state: TState;
}

export interface StoreResult<TState> {
  state: TState;
}

export interface SpawnParams<TState> {
  parentState: TState;
  childCtx: ExecutionContext;
}

export interface SpawnResult<TState> {
  childState: TState | null;
  items?: Item[];
}

export interface ReturnParams<TState> {
  childState: TState;
  childLog: ItemLog;
  parentState: TState;
  result: unknown;
}

export interface ReturnResult<TState> {
  parentState: TState;
  result?: unknown;
}

export interface CompleteParams<TState> {
  log: ItemLog;
  ctx: ExecutionContext;
  state: TState;
  outcome: ExecutionOutcome;
}

export interface DisposeParams<TState> {
  state: TState;
}

// Memory hooks interface
export interface MemoryHooks<TState = unknown> {
  init?: (params: InitParams) => Promise<InitResult<TState>>;
  recall?: (params: RecallParams<TState>) => Promise<RecallResult<TState> | string | null>;
  store?: (params: StoreParams<TState>) => Promise<StoreResult<TState> | undefined>;
  onSpawn?: (params: SpawnParams<TState>) => Promise<SpawnResult<TState> | null>;
  onReturn?: (params: ReturnParams<TState>) => Promise<ReturnResult<TState> | undefined>;
  onComplete?: (params: CompleteParams<TState>) => Promise<
    | undefined
    | {
        state: TState;
      }
  >;
  dispose?: (params: DisposeParams<TState>) => Promise<void>;
}

/** A composable memory layer that participates in the recall/store lifecycle. */
export interface MemoryLayer<TState = unknown> {
  /** Unique identifier for this layer instance. */
  id: string;
  /** Human-readable name for debugging and trace output. */
  name?: string;
  /** Ordering slot (lower = recalled first). Use `Slot` constants for well-known positions. */
  slot: number;
  /** Scope controlling state isolation: `'thread'`, `'resource'`, `'global'`, or `'execution'`. */
  scope: MemoryScope;
  /** Token budget: a fixed number, a `{ min, max }` range, or `'auto'` for dynamic allocation. */
  budget?: BudgetConfig;
  /** Lifecycle hooks invoked by the runtime at each phase (init, recall, store, etc.). */
  hooks: MemoryHooks<TState>;
  /** Per-hook timeout overrides in ms. */
  timeouts?: Partial<LayerTimeouts>;
}

// Projection policy
export interface ProjectionPolicy {
  tokenBudget: number;
  responseReserve: number;
  overflow: 'truncate' | 'summarize' | 'sliding_window';
  overflowModel?: string;
  windowSize?: number;
}
