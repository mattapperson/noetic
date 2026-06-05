import type { Channel, ExternalChannel } from '@noetic-tools/types';
import type { ZodType } from 'zod';

/**
 * Creates a typed communication channel writable from outside the execution tree.
 *
 * @public
 * @param name - Channel name for identification and debugging.
 * @param opts.schema - Zod schema used to validate every message sent through the channel.
 * @param opts.mode - Delivery semantics: `'value'` (last-write-wins), `'queue'` (FIFO), `'topic'` (pub/sub).
 * @param opts.capacity - Buffer size for queue mode (default: 1000). Ignored for value/topic modes.
 * @param opts.external - Must be `true` to create an externally writable channel.
 * @returns An `ExternalChannel`.
 */
export function channel<T>(
  name: string,
  opts: {
    schema: ZodType<T>;
    mode: 'value' | 'queue' | 'topic';
    capacity?: number;
    external: true;
  },
): ExternalChannel<T>;

/**
 * Creates a typed communication channel for inter-step messaging within an execution tree.
 *
 * @public
 * @param name - Channel name for identification and debugging.
 * @param opts.schema - Zod schema used to validate every message sent through the channel.
 * @param opts.mode - Delivery semantics: `'value'` (last-write-wins), `'queue'` (FIFO), `'topic'` (pub/sub).
 * @param opts.capacity - Buffer size for queue mode (default: 1000). Ignored for value/topic modes.
 * @param opts.external - Omit or set to `false` for internal-only channels.
 * @returns A `Channel`.
 */
export function channel<T>(
  name: string,
  opts: {
    schema: ZodType<T>;
    mode: 'value' | 'queue' | 'topic';
    capacity?: number;
    external?: false;
  },
): Channel<T>;

export function channel<T>(
  name: string,
  opts: {
    schema: ZodType<T>;
    mode: 'value' | 'queue' | 'topic';
    capacity?: number;
    external?: boolean;
  },
): Channel<T> | ExternalChannel<T> {
  const ch: Channel<T> = {
    name,
    schema: opts.schema,
    mode: opts.mode,
    capacity: opts.capacity,
  };
  if (opts.external) {
    return {
      ...ch,
      external: true as const,
    };
  }
  return ch;
}
