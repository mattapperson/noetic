import type { ZodType } from 'zod';

/**
 * A typed communication channel between steps within an execution tree.
 * @public
 */
export interface Channel<T> {
  /** Channel name for identification and debugging. */
  readonly name: string;
  /** Zod schema used to validate every message sent through the channel. */
  readonly schema: ZodType<T>;
  /** Delivery semantics: `'value'` (last-write-wins), `'queue'` (FIFO), `'topic'` (pub/sub). */
  readonly mode: 'value' | 'queue' | 'topic';
  /** Buffer size for queue mode (default: 1000). Ignored for value/topic modes. */
  readonly capacity?: number;
}

/**
 * A channel that is writable from outside the execution tree (e.g. user input).
 * @public
 */
export interface ExternalChannel<T> extends Channel<T> {
  /** Marker indicating the channel accepts writes from external callers. */
  readonly external: true;
}

/** @public Handle for sending messages to a channel and checking its closed state. */
export interface ChannelHandle<T> {
  /**
   * External-sender write: synchronous and never back-pressured. When a
   * queue channel is at capacity the OLDEST item is dropped (with a warning)
   * so external callers (HTTP handlers, CLI prompts) never block. Internal
   * senders (`ctx.send`) get async back-pressure instead.
   */
  send(value: T): void;
  readonly closed: boolean;
  readonly channel: Channel<T>;
}
