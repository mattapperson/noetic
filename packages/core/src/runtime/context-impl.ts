import type { Context, ItemLog } from '../types/context';
import type { Item } from '../types/items';
import type { TokenUsage, StepMeta } from '../types/common';
import type { Span } from '../types/observability';
import type { Channel } from '../types/channel';

class NoopSpan implements Span {
  readonly traceId = crypto.randomUUID();
  readonly spanId = crypto.randomUUID();
  readonly parentSpanId = null;
  setAttribute(_key: string, _value: string | number | boolean): void {}
  addEvent(_name: string, _attributes?: Record<string, string | number | boolean>): void {}
  end(): void {}
}

class ItemLogImpl implements ItemLog {
  private _items: Item[] = [];
  get items(): ReadonlyArray<Item> {
    return this._items;
  }
  append(item: Item): void {
    this._items.push(item);
  }
}

export class ContextImpl implements Context {
  readonly id: string;
  stepCount: number = 0;
  readonly tokens: TokenUsage = { input: 0, output: 0, total: 0 };
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

  constructor(opts?: {
    parent?: Context;
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
    span?: Span;
  }) {
    this.id = crypto.randomUUID();
    this._createdAt = Date.now();
    this.state = opts?.state ?? {};
    this.parent = opts?.parent ?? null;
    this.depth = this.parent ? this.parent.depth + 1 : 0;
    this.span = opts?.span ?? new NoopSpan();
    this.threadId = opts?.threadId ?? crypto.randomUUID();
    this.resourceId = opts?.resourceId;

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

  recv<T>(_channel: Channel<T>, _opts?: { timeout?: number }): Promise<T> {
    return Promise.reject(new Error('Not implemented'));
  }

  send<T>(_channel: Channel<T>, _value: T): void {
    throw new Error('Not implemented');
  }

  tryRecv<T>(_channel: Channel<T>): T | null {
    throw new Error('Not implemented');
  }

  async checkpoint(): Promise<void> {}

  complete<T>(_value: T): void {}

  abort(_reason?: string): void {}
}
