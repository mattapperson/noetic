import type {
  DeliveryMode,
  ExecuteInput,
  ExecuteOptions,
  InputMessageItem,
  Item,
} from '@noetic-tools/types';

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

/** @internal Context fields that let a model call find its session's steers. */
export interface SessionCtxExtension {
  _sessionQueue?: MessageQueue;
  /** Set on a spawned child that takes its parent's steers. */
  _forwardSteers?: boolean;
}

/** @internal Subscription callback fired after any mutation. */
export type QueueChangeListener = (size: number) => void;

//#endregion

//#region Input conversion

/** @internal Convert `execute()` input to log items. An empty string is no input. */
export function inputToItems(input: ExecuteInput): Item[] {
  if (typeof input === 'string') {
    if (input.length === 0) {
      return [];
    }
    const item: InputMessageItem = {
      id: `user-${crypto.randomUUID()}`,
      type: 'message',
      role: 'user',
      status: 'completed',
      content: [
        {
          type: 'input_text',
          text: input,
        },
      ],
    };
    return [
      item,
    ];
  }
  if (Array.isArray(input)) {
    return input;
  }
  return [
    input,
  ];
}

/** @internal The abort reason a `deliveryMode: 'interrupt'` message cancels its turn with. */
export const INTERRUPT_REASON = 'interrupt';

/** @internal Whether a queued message is a steer: one meant for the running turn. */
export function isSteer(message: QueuedMessage): boolean {
  return message.deliveryMode === 'between-rounds' || message.deliveryMode === 'next-item';
}

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

  /** Remove and return the messages `match` accepts, keeping the rest in order. */
  take(match: (message: QueuedMessage) => boolean): QueuedMessage[] {
    const taken: QueuedMessage[] = [];
    for (let i = 0; i < this.items.length; ) {
      const message = this.items[i];
      if (message && match(message)) {
        taken.push(message);
        this.items.splice(i, 1);
        continue;
      }
      i++;
    }
    if (taken.length > 0) {
      this.notify();
    }
    return taken;
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
