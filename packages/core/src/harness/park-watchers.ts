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

/** A long operation a parked turn's call waits on. */
export interface ParkedTask {
  readonly connection: string;
  readonly taskId: string;
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
  /** The long operations the parked execution's calls wait on. */
  tasks(executionId: string): Promise<ParkedTask[]>;
  /** The state of one of them now, or undefined when it cannot be read. */
  taskState(task: ParkedTask, signal: AbortSignal): Promise<string | undefined>;
  /** Resume the thread's turn. Resolves false when it could not be resumed just now. */
  /** `options` undefined: the harness finds them (`turnOptions`). */
  wake(threadId: string, options: ExecuteOptions | undefined): Promise<boolean>;
  /** The execution of the turn the thread has parked now, or undefined when it has none. */
  parked(threadId: string): Promise<string | undefined>;
  now(): number;
}

/** What is known about one parked turn. */
export interface ParkedTurn {
  readonly executionId: string;
  /** When its earliest wait runs out, or undefined when none has a deadline. */
  readonly until: number | undefined;
  /** The `execute()` options the turn ran with, to resume it with. */
  readonly options?: ExecuteOptions;
}

interface Watcher {
  readonly controller: AbortController;
  timer: ReturnType<typeof setTimeout> | undefined;
  debounce: ReturnType<typeof setTimeout> | undefined;
}

/** @public How long auto-wake waits after an event before waking a turn, so a burst wakes it once. */
export const DEFAULT_WAKE_DEBOUNCE_MS = 250;
/** @public How often auto-wake reads the state of a long operation a parked turn waits on. */
export const DEFAULT_TASK_POLL_MS = 5e3;
/** The longest delay a timer takes; a later deadline is reached in several steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How many times a wake is tried while the runner is still closing the parked turn out. */
const WAKE_ATTEMPTS = 100;
const WAKE_RETRY_MS = 20;

//#endregion

//#region Helpers

/** Resolves after `ms`, or as soon as `signal` aborts. Leaves no listener behind. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, {
      once: true,
    });
  });
}

//#endregion

//#region ParkWatchers

/** One harness's watchers, by thread. */
export class ParkWatchers {
  private readonly watchers = new Map<string, Watcher>();
  /** The last cursor seen for a wait, so a turn that parks again does not see it twice. */
  private readonly seen = new Map<string, string>();
  /** The harness closed: a wake still being tried is given up. */
  private closed = false;

  constructor(
    private readonly host: ParkWatcherHost,
    private readonly debounceMs: number,
    private readonly taskPollMs: number,
  ) {}

  /** True when the thread's parked turn is being watched. */
  has(threadId: string): boolean {
    return this.watchers.has(threadId);
  }

  /** Watch over a turn that just parked, or that storage says is parked. */
  watch(threadId: string, turn: ParkedTurn): void {
    this.closed = false;
    this.stop(threadId);
    const watcher: Watcher = {
      controller: new AbortController(),
      timer: undefined,
      debounce: undefined,
    };
    this.watchers.set(threadId, watcher);
    this.armDeadline(threadId, watcher, turn);
    void this.listenForWaits(threadId, watcher, turn);
    void this.pollTasks(threadId, watcher, turn).catch(() => undefined);
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
    this.closed = true;
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

  /**
   * A long operation has no event to listen for, so its state is read every so
   * often. The turn is woken when the state is no longer the one it parked on:
   * finished, failed, or asking a question. A state it already woke for does not
   * wake it again, or a turn waiting on a person's answer would never rest.
   */
  private async pollTasks(threadId: string, watcher: Watcher, turn: ParkedTurn): Promise<void> {
    const signal = watcher.controller.signal;
    const tasks = await this.host.tasks(turn.executionId);
    while (tasks.length > 0 && !signal.aborted) {
      for (const task of tasks) {
        const state = await this.host.taskState(task, signal);
        const key = `${turn.executionId}\u0000task\u0000${task.taskId}`;
        if (state === 'working') {
          // Back at work: the state it left is news again the next time it comes,
          // as when a task asks a second question.
          this.seen.delete(key);
          continue;
        }
        if (state === undefined || this.seen.get(key) === state) {
          continue;
        }
        this.seen.set(key, state);
        void this.fire(threadId, watcher, turn);
        return;
      }
      await pause(this.taskPollMs, signal);
    }
  }

  /** Wake the turn. The runner may still be closing the parked turn out, so try for a while. */
  private async fire(threadId: string, watcher: Watcher, turn: ParkedTurn): Promise<void> {
    if (this.watchers.get(threadId) !== watcher) {
      return;
    }
    this.stop(threadId);
    for (let attempt = 0; attempt < WAKE_ATTEMPTS; attempt += 1) {
      // Watched over, replaced by a newer watch, or the harness closed: not ours to wake.
      if (this.closed || this.watchers.has(threadId)) {
        return;
      }
      // The turn this watcher stood in for is gone: another harness woke it, and
      // what the thread holds now, if anything, is a different turn or the same
      // one stopped. Waking by thread id would resume that one.
      if ((await this.host.parked(threadId)) !== turn.executionId) {
        return;
      }
      if (await this.host.wake(threadId, turn.options)) {
        return;
      }
      await pause(WAKE_RETRY_MS);
    }
    // Every try failed and the turn is still parked: go on watching it, or nothing would.
    if (!this.closed && !this.watchers.has(threadId)) {
      this.watch(threadId, turn);
    }
  }
}

//#endregion
