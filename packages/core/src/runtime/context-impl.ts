import type { Context, ItemLog } from '../types/context';
import type { Item } from '../types/items';
import type { TokenUsage, StepMeta } from '../types/common';
import type { Span } from '../types/observability';
import type { Channel } from '../types/channel';
import type { ChannelStore } from './channel-store';
import { ItemLogImpl } from './item-log-impl';

class NoopSpan implements Span {
  readonly traceId = crypto.randomUUID();
  readonly spanId = crypto.randomUUID();
  readonly parentSpanId = null;
  setAttribute(_key: string, _value: string | number | boolean): void {}
  addEvent(_name: string, _attributes?: Record<string, string | number | boolean>): void {}
  end(): void {}
}

export class ContextImpl implements Context {
  readonly id: string;
  stepCount: number = 0;
  tokens: TokenUsage = { input: 0, output: 0, total: 0 };
  cost: number = 0;
  state: unknown;
  readonly parent: Context | null;
  readonly depth: number;
  readonly span: Span;
  readonly threadId: string;
  readonly resourceId?: string;
  readonly itemLog: ItemLog;
  lastStepMeta: StepMeta | null = null;

  private readonly _createdAt: number;
  private readonly channelStore?: ChannelStore;
  private _aborted = false;
  private _abortReason?: string;

  constructor(opts?: {
    parent?: Context;
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
    span?: Span;
    channelStore?: ChannelStore;
  }) {
    this.id = crypto.randomUUID();
    this._createdAt = Date.now();
    this.state = opts?.state ?? {};
    this.parent = opts?.parent ?? null;
    this.depth = this.parent ? this.parent.depth + 1 : 0;
    this.span = opts?.span ?? new NoopSpan();
    this.threadId = opts?.threadId ?? crypto.randomUUID();
    this.resourceId = opts?.resourceId;
    this.channelStore = opts?.channelStore;

    const log = new ItemLogImpl();
    if (opts?.items) {
      for (const item of opts.items) {
        log.append(item);
      }
    }
    this.itemLog = log;
  }

  get elapsed(): number {
    return Date.now() - this._createdAt;
  }

  get aborted(): boolean {
    return this._aborted;
  }

  recv<T>(ch: Channel<T>, opts?: { timeout?: number }): Promise<T> {
    if (!this.channelStore) {
      return Promise.reject(new Error('No channel store configured'));
    }
    return this.channelStore.recv(ch, opts?.timeout);
  }

  send<T>(ch: Channel<T>, value: T): void {
    if (!this.channelStore) {
      throw new Error('No channel store configured');
    }
    this.channelStore.send(ch, value);
  }

  tryRecv<T>(ch: Channel<T>): T | null {
    if (!this.channelStore) {
      throw new Error('No channel store configured');
    }
    return this.channelStore.tryRecv(ch);
  }

  async checkpoint(): Promise<void> {}

  complete<T>(_value: T): void {}

  get abortReason(): string | undefined {
    return this._abortReason;
  }

  abort(reason?: string): void {
    this._aborted = true;
    this._abortReason = reason;
  }
}
