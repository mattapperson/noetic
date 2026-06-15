/**
 * Pull SGR mouse-event escape sequences out of `process.stdin` before
 * downstream consumers (ink's keystroke parser, ink-text-input clones, etc.)
 * ever see them.
 *
 * Why this is necessary: once mouse reporting is enabled in the terminal,
 * scroll-wheel events arrive on stdin as `\x1b[<Cb;Cx;Cy(M|m)` sequences. Ink
 * subscribes to `process.stdin` for keystrokes; its `parseKeypress` does not
 * recognise SGR mouse, so the bytes fall through to `useInput` callbacks
 * with `input` set to `[<64;…M` and any active text input writes them into
 * its buffer. The symptom is a flood of garbage in the chat prompt under
 * trackpad scrolling.
 *
 * The fix is to wrap `process.stdin`'s `emit('data', chunk)` for the
 * lifetime of any registered subscriber:
 *
 *   1. The original chunk is scanned for mouse SGR sequences.
 *   2. Each parsed `MouseEvent` is dispatched to subscribers.
 *   3. The mouse bytes are *removed* from the chunk. If anything non-mouse
 *      remains, the original `emit` is called with the cleaned chunk; if
 *      nothing remains, no `'data'` event fires at all.
 *
 * Refcounted so multiple `useMouseScroll` subscribers can coexist and the
 * monkey-patch is reverted as soon as the last one unsubscribes.
 *
 * Tested in isolation via `iterMouseEventsWithReplacement` so the runtime
 * coupling to `process.stdin` doesn't make the contract opaque.
 */

import type { MouseEvent } from './parse-mouse-event.js';
import { parseMouseEvent } from './parse-mouse-event.js';

//#region Pure helpers (testable without monkey-patching anything)

interface FilterResult {
  events: MouseEvent[];
  /** Chunk with all SGR mouse sequences removed. May be empty. */
  cleaned: string;
}

/**
 * Walk `chunk`, extract every SGR mouse event, and return the parsed events
 * plus the chunk with those bytes excised. Non-mouse bytes (keystrokes,
 * stray ESCs, plain text) are preserved verbatim and in the same order.
 *
 * Exported so the contract is unit-testable; not part of the public API.
 */
export function iterMouseEventsWithReplacement(chunk: string): FilterResult {
  const events: MouseEvent[] = [];
  let cleaned = '';
  let i = 0;
  while (i < chunk.length) {
    const parsed = parseMouseEvent(chunk.slice(i));
    if (parsed) {
      events.push(parsed.event);
      i += parsed.consumed;
      continue;
    }
    cleaned += chunk[i];
    i++;
  }
  return {
    events,
    cleaned,
  };
}

//#endregion

//#region Refcounted runtime patch

export type MouseEventListener = (event: MouseEvent) => void;

interface PatchState {
  refCount: number;
  listeners: Set<MouseEventListener>;
  originalEmit: typeof process.stdin.emit;
}

let state: PatchState | null = null;

function installPatch(): PatchState {
  const originalEmit = process.stdin.emit.bind(process.stdin);
  const listeners = new Set<MouseEventListener>();
  process.stdin.emit = function patchedEmit(event: string | symbol, ...args: unknown[]): boolean {
    if (event !== 'data' || args.length === 0) {
      return originalEmit(event, ...args);
    }
    const first = args[0];
    const chunk =
      typeof first === 'string' ? first : Buffer.isBuffer(first) ? first.toString('utf8') : null;
    if (chunk === null) {
      return originalEmit(event, ...args);
    }
    const { events, cleaned } = iterMouseEventsWithReplacement(chunk);
    for (const ev of events) {
      for (const listener of listeners) {
        try {
          listener(ev);
        } catch {
          // A misbehaving subscriber must not break stdin dispatch for others.
        }
      }
    }
    if (cleaned.length === 0) {
      return false;
    }
    return originalEmit(event, cleaned, ...args.slice(1));
  };
  return {
    refCount: 0,
    listeners,
    originalEmit,
  };
}

function uninstallPatch(s: PatchState): void {
  process.stdin.emit = s.originalEmit;
}

/**
 * Register a mouse-event subscriber. Returns an unsubscribe function. The
 * stdin patch is installed lazily on first subscribe and removed on last
 * unsubscribe, so a process with no mouse listeners pays nothing.
 */
export function subscribeMouseEvents(listener: MouseEventListener): () => void {
  if (state === null) {
    state = installPatch();
  }
  state.listeners.add(listener);
  state.refCount += 1;
  return (): void => {
    if (state === null) {
      return;
    }
    state.listeners.delete(listener);
    state.refCount -= 1;
    if (state.refCount <= 0) {
      uninstallPatch(state);
      state = null;
    }
  };
}

//#endregion
