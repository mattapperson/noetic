/**
 * Parking: letting a turn stop holding a process while every part of it waits
 * (spec 23 § Parked turns).
 *
 * A turn that reaches a `wait` step today sits on a timer until the event comes.
 * What it waits for is already in storage (the pending entry: connection, event,
 * cursor, deadline), so the process adds nothing but its own uptime. A parked
 * turn drops the process: its record says `parked` and when to wake it, its lease
 * is handed back, and any harness on the same storage picks it up later. The
 * ledger replays what finished, and the wait listens again from its cursor.
 *
 * `Parking` decides when that is safe. It tracks the steps in flight and parks
 * only when every innermost one is a wait that can be resumed without loss. A
 * step doing anything else — a model call, user code, a tool — keeps the turn
 * live.
 */

//#region Types

/** The abort reason of a context whose turn parked. */
export const PARK_REASON = 'parked';

/** @public How long every in-flight step must stay waiting before a turn parks, by default. */
export const DEFAULT_PARK_GRACE_MS = 100;

/** @internal What arms a turn's parking. */
export interface ParkingOptions {
  /** How long every in-flight step must stay waiting before the turn parks. */
  readonly graceMs: number;
  /** Called once, with the earliest deadline among the waits. */
  readonly onPark: (wakeAt: number) => void;
}

interface Running {
  /** Steps in flight directly beneath this one. */
  children: number;
  /** Set while the step is a parkable wait: when it stops waiting on its own. */
  until?: number;
}

//#endregion

//#region Paths

/** Whether `path` lies in the subtree under `parent` — a lane below it or a child context's prefix. */
export function isBeneath(path: string, parent: string): boolean {
  return path.startsWith(`${parent}/`) || path.startsWith(`${parent}[`);
}

//#endregion

//#region Parking

/**
 * @internal
 * One execution's parking state. Lives on the step ledger, which every context
 * of the execution already shares.
 */
export class Parking {
  private readonly running = new Map<string, Running>();
  private armed: ParkingOptions | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private until: number | undefined;
  private anonymous = 0;

  /** Turn parking on for this execution. Without it nothing ever parks. */
  arm(options: ParkingOptions): void {
    this.armed = options;
  }

  /** When the parked turn should be woken, or undefined while it has not parked. */
  get parkedUntil(): number | undefined {
    return this.until;
  }

  /**
   * A step began running at `path`. Returns what to call when it is done. A step
   * with no path is tracked on its own, so it still keeps the turn live.
   */
  enter(path: string | undefined): () => void {
    const key = path ?? `~${this.anonymous++}`;
    const parent = path === undefined ? undefined : this.parentOf(path);
    if (parent) {
      parent.children += 1;
    }
    this.running.set(key, {
      children: 0,
    });
    this.settle();
    return () => {
      if (!this.running.delete(key)) {
        return;
      }
      if (parent) {
        parent.children -= 1;
      }
      this.settle();
    };
  }

  /**
   * The step at `path` is waiting until `until` and can be resumed without loss.
   * Returns what to call when it stops waiting.
   */
  wait(path: string | undefined, until: number): () => void {
    const entry = path === undefined ? undefined : this.running.get(path);
    if (!entry) {
      return () => {};
    }
    entry.until = until;
    this.settle();
    return () => {
      entry.until = undefined;
      this.settle();
    };
  }

  /** The step in flight that `path` is directly beneath. */
  private parentOf(path: string): Running | undefined {
    let found: string | undefined;
    for (const key of this.running.keys()) {
      if (isBeneath(path, key) && (found === undefined || key.length > found.length)) {
        found = key;
      }
    }
    return found === undefined ? undefined : this.running.get(found);
  }

  /** The earliest deadline when every innermost step is waiting, else undefined. */
  private wakeAt(): number | undefined {
    let earliest: number | undefined;
    for (const entry of this.running.values()) {
      if (entry.children > 0) {
        continue;
      }
      if (entry.until === undefined) {
        return undefined;
      }
      earliest = earliest === undefined ? entry.until : Math.min(earliest, entry.until);
    }
    return earliest;
  }

  /** Start or cancel the countdown to parking, after any change. */
  private settle(): void {
    const armed = this.armed;
    if (!armed || this.until !== undefined) {
      return;
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.wakeAt() === undefined) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const wakeAt = this.wakeAt();
      if (wakeAt === undefined) {
        return;
      }
      this.until = wakeAt;
      armed.onPark(wakeAt);
    }, armed.graceMs);
  }
}

//#endregion
