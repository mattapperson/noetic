import type { ExecuteInput } from '../types/items';
import type { DeliveryMode, ExecuteOptions } from '../types/runtime';

//#region Types

/** @internal A message accepted by `AgentHarness.execute()` and held until the
 *  session runner processes it. The effective `DeliveryMode` is resolved at
 *  enqueue time so the runner never has to look at harness defaults again. */
export interface QueuedMessage {
  readonly id: string;
  readonly input: ExecuteInput;
  readonly deliveryMode: DeliveryMode;
  readonly options: ExecuteOptions;
  readonly enqueuedAt: number;
}

/** @internal Subscription callback fired after any mutation. */
export type QueueChangeListener = (size: number) => void;

//#endregion

//#region MessageQueue

/** @internal Per-thread FIFO of inbox messages with prepend + subscription.
 *
 *  `prepend` is used when an in-flight turn is aborted — the aborting message
 *  is re-inserted at the head so the runner picks it up before any messages
 *  that arrived after the abort. */
export class MessageQueue {
  private readonly items: QueuedMessage[] = [];
  private readonly listeners = new Set<QueueChangeListener>();

  enqueue(message: QueuedMessage): void {
    this.items.push(message);
    this.notify();
  }

  prepend(message: QueuedMessage): void {
    this.items.unshift(message);
    this.notify();
  }

  drainAll(): QueuedMessage[] {
    if (this.items.length === 0) {
      return [];
    }
    const drained = this.items.splice(0, this.items.length);
    this.notify();
    return drained;
  }

  peekAll(): ReadonlyArray<QueuedMessage> {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  subscribe(listener: QueueChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const size = this.items.length;
    for (const listener of this.listeners) {
      listener(size);
    }
  }
}

//#endregion
