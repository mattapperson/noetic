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

type ChangeListener = BufferedStreamOptions['onChange'];

/** The bounded queue between the pump and the consumer. */
interface BufferState {
  readonly limit: number;
  readonly queue: Message[];
  readonly waiters: Array<(result: IteratorResult<Message>) => void>;
  ended: boolean;
  /** Set once the consumer closes the stream. */
  closed: boolean;
  /** How many `event` messages the queue holds. */
  buffered: number;
  droppedTotal: number;
  overflowGap: Message | undefined;
}

//#endregion

//#region Buffer

function done(): IteratorResult<Message> {
  return {
    value: undefined,
    done: true,
  };
}

function dropOldestEvents(state: BufferState): number {
  let dropped = 0;
  while (state.buffered > state.limit) {
    const index = state.queue.findIndex((m) => m.type === 'event');
    state.queue.splice(index, 1);
    state.buffered -= 1;
    dropped += 1;
  }
  return dropped;
}

/** Records `dropped` overflowed events as one gap at the head, merging with an unread one. */
function recordOverflow(state: BufferState, dropped: number): string {
  const merging = state.overflowGap !== undefined && state.queue[0] === state.overflowGap;
  state.droppedTotal = merging ? state.droppedTotal + dropped : dropped;
  const reason = `wait buffer overflowed: ${state.droppedTotal} oldest event(s) dropped`;
  const gap: Message = {
    type: 'gap',
    reason,
  };
  if (merging) {
    state.queue[0] = gap;
  } else {
    state.queue.unshift(gap);
  }
  state.overflowGap = gap;
  return reason;
}

function trim(state: BufferState, onChange: ChangeListener): void {
  const dropped = dropOldestEvents(state);
  if (dropped === 0) {
    return;
  }
  const reason = recordOverflow(state, dropped);
  onChange?.({
    change: 'gap',
    reason,
  });
}

function deliver(state: BufferState, message: Message, onChange: ChangeListener): void {
  const waiter = state.waiters.shift();
  if (waiter) {
    waiter({
      value: message,
      done: false,
    });
    return;
  }
  state.queue.push(message);
  if (message.type === 'event') {
    state.buffered += 1;
  }
  trim(state, onChange);
}

function finish(state: BufferState): void {
  state.ended = true;
  for (const waiter of state.waiters.splice(0)) {
    waiter(done());
  }
}

function takeNext(state: BufferState): Promise<IteratorResult<Message>> {
  const message = state.queue.shift();
  if (message?.type === 'event') {
    state.buffered -= 1;
  }
  if (message) {
    return Promise.resolve({
      value: message,
      done: false,
    });
  }
  if (state.ended) {
    return Promise.resolve(done());
  }
  return new Promise((resolve) => {
    state.waiters.push(resolve);
  });
}

//#endregion

//#region Pump

/** Hands one source message on; returns whether the stream ended with it. */
async function forwardMessage(
  state: BufferState,
  message: EventStreamMessage,
  options: BufferedStreamOptions,
): Promise<boolean> {
  if (message.type === 'event') {
    const event = await options.transform(message.event);
    options.onEvent?.(event);
    deliver(
      state,
      {
        type: 'event',
        event,
      },
      options.onChange,
    );
    return false;
  }
  const change = message.type === 'gap' ? 'gap' : 'ended';
  options.onChange?.({
    change,
    reason: message.reason,
  });
  deliver(state, message, options.onChange);
  return change === 'ended';
}

async function pump(
  state: BufferState,
  source: EventStream,
  options: BufferedStreamOptions,
): Promise<void> {
  try {
    for await (const message of source) {
      if (state.closed || (await forwardMessage(state, message, options))) {
        break;
      }
    }
  } catch (e) {
    if (state.closed) {
      return;
    }
    const reason = e instanceof Error ? e.message : String(e);
    options.onChange?.({
      change: 'ended',
      reason,
    });
    deliver(
      state,
      {
        type: 'terminated',
        reason,
      },
      options.onChange,
    );
  } finally {
    finish(state);
  }
}

//#endregion

//#region Public API

/** Wraps a provider stream in a bounded, transforming buffer. */
export function bufferedEventStream(
  source: EventStream,
  options: BufferedStreamOptions,
): EventStream<ConnectionEvent> {
  const state: BufferState = {
    limit: options.limit ?? WAIT_BUFFER_LIMIT,
    queue: [],
    waiters: [],
    ended: false,
    closed: false,
    buffered: 0,
    droppedTotal: 0,
    overflowGap: undefined,
  };
  const closeSource = async (): Promise<void> => {
    state.closed = true;
    finish(state);
    await source.close();
  };

  void source.ready.then(
    () => pump(state, source, options),
    () => finish(state),
  );

  return {
    ready: source.ready,
    close: closeSource,
    [Symbol.asyncIterator](): AsyncIterator<Message> {
      return {
        next: () => takeNext(state),
        async return(): Promise<IteratorResult<Message>> {
          await closeSource();
          return done();
        },
      };
    },
  };
}

//#endregion
