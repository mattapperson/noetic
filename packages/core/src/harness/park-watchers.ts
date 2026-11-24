/**
 * Auto-wake: a live harness watching over the turns it parked
 * (spec 23 § Parked turns).
 *
 * Parking closes a turn's own listener, so without this a parked turn in a
 * long-lived process would sit until something outside called `wake()`. A
 * watcher stands in for the turn: a timer for its deadline, and a listener on
 * each event it waits for, from the cursor the wait recorded. Either one wakes
 * the turn.
 *
 * A watcher knows the event's type, not the wait's `filter`, which is code in
 * the flow. So it wakes on any event of that type, and a turn the filter turns
 * down parks again. It remembers the last cursor it saw, so each event wakes
 * the turn at most once, and a burst of events wakes it once.
 */

import type { ConnectionEventInit, EventStream, ExecuteOptions } from '@noetic-tools/types';

//#region Types

/** An event a parked turn waits for. */
export interface ParkedWait {
  readonly connection: string;
  readonly event: string;
  readonly cursor: string | null;
}

/** What the watchers need of their harness. */
export interface ParkWatcherHost {
  /** Listen on a harness connection. */
  listen(
    connection: string,
    request: {
      event: string;
      cursor: string | null;
      signal: AbortSignal;
    },
  ): Promise<EventStream<ConnectionEventInit>>;
  /** The events the parked execution waits for. */
  waits(executionId: string): Promise<ParkedWait[]>;
  /** Resume the thread's turn. Resolves false when it could not be resumed just now. */
  wake(threadId: string, options: ExecuteOptions): Promise<boolean>;
  now(): number;
}

/** What is known about one parked turn. */
export interface ParkedTurn {
  readonly executionId: string;
  /** When its earliest wait runs out, or undefined when none has a deadline. */
  readonly until: number | undefined;
  /** The `execute()` options the turn ran with, to resume it with. */
  readonly options: ExecuteOptions;
}

interface Watcher {
  readonly controller: AbortController;
  timer: ReturnType<typeof setTimeout> | undefined;
  debounce: ReturnType<typeof setTimeout> | undefined;
}

/** @public How long auto-wake waits after an event before waking a turn, so a burst wakes it once. */
export const DEFAULT_WAKE_DEBOUNCE_MS = 250;
/** The longest delay a timer takes; a later deadline is reached in several steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How many times a wake is tried while the runner is still closing the parked turn out. */
const WAKE_ATTEMPTS = 100;
const WAKE_RETRY_MS = 20;

//#endregion

//#region ParkWatchers

/** One harness's watchers, by thread. */
export class ParkWatchers {
  private readonly watchers = new Map<string, Watcher>();
  /** The last cursor seen for a wait, so a turn that parks again does not see it twice. */
  private readonly seen = new Map<string, string>();

  constructor(
    private readonly host: ParkWatcherHost,
    private readonly debounceMs: number,
  ) {}

  /** True when the thread's parked turn is being watched. */
  has(threadId: string): boolean {
    return this.watchers.has(threadId);
  }

  /** Watch over a turn that just parked, or that storage says is parked. */
  watch(threadId: string, turn: ParkedTurn): void {
    this.stop(threadId);
    const watcher: Watcher = {
      controller: new AbortController(),
      timer: undefined,
      debounce: undefined,
    };
    this.watchers.set(threadId, watcher);
    this.armDeadline(threadId, watcher, turn);
    void this.listenForWaits(threadId, watcher, turn);
  }

  /** Stop watching a thread: its turn was woken, or is being. */
  stop(threadId: string): void {
    const watcher = this.watchers.get(threadId);
    if (!watcher) {
      return;
    }
    this.watchers.delete(threadId);
    watcher.controller.abort();
    clearTimeout(watcher.timer);
    clearTimeout(watcher.debounce);
  }

  /** The turn ended: drop what was remembered about its waits. */
  forget(threadId: string, executionId: string): void {
    this.stop(threadId);
    for (const key of [
      ...this.seen.keys(),
    ]) {
      if (key.startsWith(`${executionId}\u0000`)) {
        this.seen.delete(key);
      }
    }
  }

  stopAll(): void {
    for (const threadId of [
      ...this.watchers.keys(),
    ]) {
      this.stop(threadId);
    }
  }

  private armDeadline(threadId: string, watcher: Watcher, turn: ParkedTurn): void {
    if (turn.until === undefined) {
      return;
    }
    const until = turn.until;
    const tick = (): void => {
      const left = until - this.host.now();
      if (left <= 0) {
        void this.fire(threadId, watcher, turn);
        return;
      }
      watcher.timer = setTimeout(tick, Math.min(left, MAX_TIMER_MS));
    };
    tick();
  }

  private async listenForWaits(
    threadId: string,
    watcher: Watcher,
    turn: ParkedTurn,
  ): Promise<void> {
    let waits: ParkedWait[];
    try {
      waits = await this.host.waits(turn.executionId);
    } catch {
      // The deadline still wakes it.
      return;
    }
    for (const wait of waits) {
      void this.listenFor(threadId, watcher, turn, wait).catch(() => undefined);
    }
  }

  /** Listen for one awaited event; the first one seen wakes the turn, after the debounce. */
  private async listenFor(
    threadId: string,
    watcher: Watcher,
    turn: ParkedTurn,
    wait: ParkedWait,
  ): Promise<void> {
    const signal = watcher.controller.signal;
    const key = `${turn.executionId}\u0000${wait.connection}\u0000${wait.event}`;
    const stream = await this.host.listen(wait.connection, {
      event: wait.event,
      cursor: this.seen.get(key) ?? wait.cursor,
      signal,
    });
    await stream.ready;
    for await (const message of stream) {
      if (signal.aborted) {
        return;
      }
      if (message.type !== 'event' || message.event.type !== wait.event) {
        continue;
      }
      if (message.event.cursor !== null) {
        this.seen.set(key, message.event.cursor);
      }
      // Keep reading during the debounce: later events of the burst move the cursor on.
      watcher.debounce ??= setTimeout(() => {
        void this.fire(threadId, watcher, turn);
      }, this.debounceMs);
    }
  }

  /** Wake the turn. The runner may still be closing the parked turn out, so try for a while. */
  private async fire(threadId: string, watcher: Watcher, turn: ParkedTurn): Promise<void> {
    if (this.watchers.get(threadId) !== watcher) {
      return;
    }
    this.stop(threadId);
    for (let attempt = 0; attempt < WAKE_ATTEMPTS; attempt += 1) {
      if (await this.host.wake(threadId, turn.options)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, WAKE_RETRY_MS));
    }
  }
}

//#endregion
