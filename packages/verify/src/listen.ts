/**
 * Listen (spec 37 § How it runs, step 3): one event stream per event a
 * participant must watch, started and confirmed before the action runs, and
 * pumped into the run state until the window closes.
 */

import type { ConnectionEvent, EventStream, EventStreamMessage } from '@noetic-tools/types';
import { isRedacted, observeEvent } from './observations';
import type { RunParticipant, RunState } from './run-state';

//#region Types

/** One live subscription. */
export interface Listener {
  readonly participant: RunParticipant;
  readonly event: string;
  readonly channel: string;
  readonly stream: EventStream<ConnectionEvent>;
  /** Settles when the stream ends or is closed. */
  done: Promise<void>;
}

/** Called for every event, after it is recorded. */
export type OnEvent = (listener: Listener, event: ConnectionEvent) => void;

//#endregion

//#region Constants

/** Events whose arrival closes an `until: 'exit'` window, by sense (spec 36 `app@1`). */
export const EXIT_SENSES: Readonly<Record<string, 'exit' | 'terminated'>> = {
  'x-exit': 'exit',
  'x-termination': 'terminated',
};

export const WINDOW_ID = 'window';

/** How long a closed stream gets to finish its pump. */
const STOP_GRACE_MS = 250;

//#endregion

//#region Helpers

/** Events to listen to on one participant: those its matchers name, and every event on a sense it watches. */
function eventsFor(state: RunState, p: RunParticipant, extra: ReadonlyArray<string>): string[] {
  const named = state.prepared.events[p.name] ?? [];
  const bySense = Object.values(p.connection.manifest.events)
    .filter((info) => info.sense !== undefined && p.senses.includes(info.sense))
    .map((info) => info.name);
  return [
    ...new Set([
      ...named,
      ...bySense,
      ...extra,
    ]),
  ];
}

function channelOf(p: RunParticipant, event: string): string {
  return p.connection.manifest.events[event]?.sense ?? 'signal';
}

function handleMessage(opts: {
  state: RunState;
  listener: Listener;
  message: EventStreamMessage<ConnectionEvent>;
  onEvent: OnEvent;
}): void {
  const { state, listener, message, onEvent } = opts;
  if (state.closed) {
    return;
  }
  if (message.type === 'gap') {
    state.gap(
      'buffer-truncated',
      `${listener.participant.name} skipped ${listener.event} events: ${message.reason}`,
      {
        channel: listener.channel,
      },
    );
    return;
  }
  if (message.type === 'terminated') {
    state.gap(
      'channel-unobserved',
      `${listener.participant.name}'s ${listener.event} stream ended: ${message.reason}`,
      {
        channel: listener.channel,
      },
    );
    return;
  }
  const event = message.event;
  state.record({
    observation: observeEvent({
      event,
      channel: listener.channel,
      window: WINDOW_ID,
      id: state.id(`${listener.participant.name}:${event.type}`),
      now: state.now(),
    }),
    participant: listener.participant.name,
    eventType: event.type,
    method: 'listen',
    subject: listener.participant.subject,
  });
  if (isRedacted(event.payload)) {
    state.gap(
      'redacted',
      `${listener.participant.name} withheld a sensitive value in ${event.type}`,
      {
        channel: listener.channel,
      },
    );
  }
  onEvent(listener, event);
}

async function pump(state: RunState, listener: Listener, onEvent: OnEvent): Promise<void> {
  try {
    for await (const message of listener.stream) {
      handleMessage({
        state,
        listener,
        message,
        onEvent,
      });
    }
  } catch (error) {
    state.gap(
      'channel-unobserved',
      `${listener.participant.name}'s ${listener.event} stream failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        channel: listener.channel,
      },
    );
  }
}

//#endregion

//#region Public API

/**
 * Starts every listener the verify needs and waits until each server confirms.
 * A stream that cannot start adds a `channel-unobserved` gap on its sense.
 */
export async function startListening(opts: {
  state: RunState;
  signal: AbortSignal;
  onEvent: OnEvent;
  /** Extra subject events to watch (close conditions). */
  subjectExtra: ReadonlyArray<string>;
}): Promise<Listener[]> {
  const { state, signal, onEvent, subjectExtra } = opts;
  const listeners: Listener[] = [];
  for (const p of state.participants) {
    const extra = p.role === 'subject' ? subjectExtra : [];
    for (const event of eventsFor(state, p, extra)) {
      const listener = await openListener({
        state,
        participant: p,
        event,
        signal,
      });
      if (!listener) {
        continue;
      }
      listener.done = pump(state, listener, onEvent);
      listeners.push(listener);
    }
  }
  return listeners;
}

async function openListener(opts: {
  state: RunState;
  participant: RunParticipant;
  event: string;
  signal: AbortSignal;
}): Promise<Listener | undefined> {
  const { state, participant, event, signal } = opts;
  const channel = channelOf(participant, event);
  try {
    const stream = participant.connection.listen({
      event,
      signal,
    });
    const { cursor } = await stream.ready;
    if (cursor !== null && !state.startCursors.has(participant.name)) {
      state.startCursors.set(participant.name, cursor);
    }
    const watched = state.listened.get(participant.name) ?? new Set<string>();
    watched.add(channel);
    state.listened.set(participant.name, watched);
    state.observed.add(channel);
    return {
      participant,
      event,
      channel,
      stream,
      done: Promise.resolve(),
    };
  } catch (error) {
    state.gap(
      'channel-unobserved',
      `${participant.name} could not listen for ${event}: ${error instanceof Error ? error.message : String(error)}`,
      {
        channel,
      },
    );
    return undefined;
  }
}

/**
 * Closes every listener and waits briefly for its pump to finish. Whatever a
 * stream delivers after this is ignored: the window is closed.
 */
export async function stopListening(listeners: ReadonlyArray<Listener>): Promise<void> {
  await Promise.all(
    listeners.map(async (l) => {
      await l.stream.close().catch(() => undefined);
      await Promise.race([
        l.done,
        new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS)),
      ]);
    }),
  );
}

//#endregion
