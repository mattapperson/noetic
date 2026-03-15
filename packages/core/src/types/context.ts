import type { Item } from './items';
import type { TokenUsage, StepMeta } from './common';
import type { Span } from './observability';
import type { Channel } from './channel';

export interface ItemLog {
  readonly items: ReadonlyArray<Item>;
  append(item: Item): void;
}

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
  recv<T>(channel: Channel<T>, opts?: { timeout?: number }): Promise<T>;
  send<T>(channel: Channel<T>, value: T): void;
  tryRecv<T>(channel: Channel<T>): T | null;
  readonly aborted: boolean;
  readonly abortReason?: string;
  checkpoint(): Promise<void>;
  complete<T>(value: T): void;
  abort(reason?: string): void;
}
