import type { Channel } from './channel';
import type { StepMeta, TokenUsage } from './common';
import type { Item } from './items';
import type { Span } from './observability';
import type { AgentHarness } from './runtime';

/** @public Append-only log of conversation items accumulated during execution. */
export interface ItemLog {
  readonly items: ReadonlyArray<Item>;
  append(item: Item): void;
}

/** @public Execution context threaded through every step, carrying state, metrics, and channels. */
export interface Context<TState = unknown> {
  readonly id: string;
  readonly stepCount: number;
  readonly tokens: TokenUsage;
  readonly elapsed: number;
  readonly cost: number;
  state: TState;
  readonly parent: Context | null;
  readonly depth: number;
  readonly span: Span;
  readonly threadId: string;
  readonly resourceId?: string;
  readonly itemLog: ItemLog;
  readonly lastStepMeta: StepMeta | null;
  readonly harness: AgentHarness;
  recv<T>(
    channel: Channel<T>,
    opts?: {
      timeout?: number;
    },
  ): Promise<T>;
  send<T>(channel: Channel<T>, value: T): void;
  tryRecv<T>(channel: Channel<T>): T | null;
  checkpoint(): Promise<void>;
  complete<T>(value: T): void;
  readonly completed: boolean;
  readonly completionValue: unknown;
  readonly aborted: boolean;
  readonly abortReason?: string;
  abort(reason?: string): void;
}
