/**
 * Waits listen in memory (spec 35 § Events): from the moment the server
 * confirms the subscription, events are pumped into a buffer of up to
 * `WAIT_BUFFER_LIMIT`. Overflow drops the oldest event and records a gap,
 * which verification reports as a blind spot. Each event is transformed on the
 * way in (stamped with the connection, refs sealed, secrets scrubbed).
 */

import type {
  ConnectionEvent,
  ConnectionEventInit,
  EventStream,
  EventStreamMessage,
} from '@noetic-tools/types';
import { WAIT_BUFFER_LIMIT } from '@noetic-tools/types';

//#region Types

/** How a buffered stream treats what comes through it. */
export interface BufferedStreamOptions {
  /** Default `WAIT_BUFFER_LIMIT`. */
  readonly limit?: number;
  /** Turns a provider event into the event the harness hands on. */
  readonly transform: (event: ConnectionEventInit) => Promise<ConnectionEvent>;
  /** Called for every gap (including overflow) and for the stream's end. */
  readonly onChange?: (change: {
    readonly change: 'gap' | 'ended';
    readonly reason: string;
  }) => void;
  /** Called for every event delivered into the buffer. */
  readonly onEvent?: (event: ConnectionEvent) => void;
}

type Message = EventStreamMessage<ConnectionEvent>;

//#endregion

//#region Public API

/** Wraps a provider stream in a bounded, transforming buffer. */
export function bufferedEventStream(
  source: EventStream,
  options: BufferedStreamOptions,
): EventStream<ConnectionEvent> {
  const limit = options.limit ?? WAIT_BUFFER_LIMIT;
  const queue: Message[] = [];
  const waiters: Array<(result: IteratorResult<Message>) => void> = [];
  let ended = false;
  let closed = false;
  let buffered = 0;
  let droppedTotal = 0;
  let overflowGap: Message | undefined;

  const deliver = (message: Message): void => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter({
        value: message,
        done: false,
      });
      return;
    }
    queue.push(message);
    if (message.type === 'event') {
      buffered += 1;
    }
    trim();
  };

  const trim = (): void => {
    let dropped = 0;
    while (buffered > limit) {
      const index = queue.findIndex((m) => m.type === 'event');
      queue.splice(index, 1);
      buffered -= 1;
      dropped += 1;
    }
    if (dropped === 0) {
      return;
    }
    const merging = overflowGap !== undefined && queue[0] === overflowGap;
    droppedTotal = merging ? droppedTotal + dropped : dropped;
    const reason = `wait buffer overflowed: ${droppedTotal} oldest event(s) dropped`;
    const gap: Message = {
      type: 'gap',
      reason,
    };
    if (merging) {
      queue[0] = gap;
    } else {
      queue.unshift(gap);
    }
    overflowGap = gap;
    options.onChange?.({
      change: 'gap',
      reason,
    });
  };

  const finish = (): void => {
    ended = true;
    for (const waiter of waiters.splice(0)) {
      waiter({
        value: undefined,
        done: true,
      });
    }
  };

  const pump = async (): Promise<void> => {
    try {
      for await (const message of source) {
        if (closed) {
          break;
        }
        if (message.type === 'event') {
          const event = await options.transform(message.event);
          options.onEvent?.(event);
          deliver({
            type: 'event',
            event,
          });
          continue;
        }
        if (message.type === 'gap') {
          options.onChange?.({
            change: 'gap',
            reason: message.reason,
          });
          deliver(message);
          continue;
        }
        options.onChange?.({
          change: 'ended',
          reason: message.reason,
        });
        deliver(message);
        break;
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (!closed) {
        options.onChange?.({
          change: 'ended',
          reason,
        });
        deliver({
          type: 'terminated',
          reason,
        });
      }
    } finally {
      finish();
    }
  };

  void source.ready.then(
    () => pump(),
    () => finish(),
  );

  return {
    ready: source.ready,
    async close(): Promise<void> {
      closed = true;
      finish();
      await source.close();
    },
    [Symbol.asyncIterator](): AsyncIterator<Message> {
      return {
        next(): Promise<IteratorResult<Message>> {
          const message = queue.shift();
          if (message?.type === 'event') {
            buffered -= 1;
          }
          if (message) {
            return Promise.resolve({
              value: message,
              done: false,
            });
          }
          if (ended) {
            return Promise.resolve({
              value: undefined,
              done: true,
            });
          }
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        },
        async return(): Promise<IteratorResult<Message>> {
          closed = true;
          finish();
          await source.close();
          return {
            value: undefined,
            done: true,
          };
        },
      };
    },
  };
}

//#endregion
