import { EventEmitter } from 'node:events';

import type { Event, EventKind } from './schemas.js';

//#region Types

/**
 * Listener invoked with a fully-formed `Event` (including the monotonic
 * `id` and persisted `ts`). Out-of-process consumers tail
 * `_events.jsonl` directly via `tailEvents` from `fs-store.ts`; this
 * emitter is in-process only.
 */
export type TaskEventListener = (event: Event) => void;

//#endregion

//#region Emitter

/**
 * In-process event bus. Consumers call `onTaskEvent(kind, listener)` to
 * subscribe to a specific `EventKind`; producers (handlers / agent-ci
 * runner) call `emitTaskEvent(event)` *after* the underlying FS write
 * has been committed via `appendEvent`.
 */
export const taskEvents = new EventEmitter();

/**
 * Fan an event out on its `kind` channel. Always called immediately
 * after `appendEvent` in the same handler so in-process listeners
 * stay consistent with the persisted `_events.jsonl` tail.
 */
export function emitTaskEvent(event: Event): void {
  taskEvents.emit(event.kind, event);
}

/** Subscribe to events of a single kind. */
export function onTaskEvent(kind: EventKind, listener: TaskEventListener): void {
  taskEvents.on(kind, listener);
}

/** Mirror of `onTaskEvent`. Idempotent: removes one matching subscription. */
export function offTaskEvent(kind: EventKind, listener: TaskEventListener): void {
  taskEvents.off(kind, listener);
}

//#endregion
