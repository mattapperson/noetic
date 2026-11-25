/**
 * The alarm preset (spec 25 § Cloudflare Workers): a Durable Object's alarm wakes
 * the harness's parked and cut turns, and the harness sets the next alarm itself,
 * through `harness.onWakeTimeChange()`.
 *
 * A Worker has no process between requests, so the harness's own timers
 * (`park.autoWake`) cannot be relied on. Build the harness with
 * `park: { autoWake: false }` and let the alarm do it.
 *
 * A Durable Object has one alarm. An object that needs it for its own work too
 * passes `schedule` in place of `alarms`, and merges the times its parts want with
 * `sharedAlarm`.
 */

import type { AgentHarness } from '@noetic-tools/core';

//#region Types

/** @public The part of a Durable Object's storage the alarm preset uses: `ctx.storage`. */
export interface AlarmStorageLike {
  setAlarm(scheduledTime: number): Promise<void> | void;
  deleteAlarm(): Promise<void> | void;
}

/** @public The part of a Durable Object's storage `sharedAlarm` uses: `ctx.storage`. */
export interface SharedAlarmStorageLike extends AlarmStorageLike {
  getAlarm(): Promise<number | null> | number | null;
}

/** @public The harness methods the alarm preset calls. An `AgentHarness` fits. */
export type WakeableHarness = Pick<
  AgentHarness,
  'start' | 'wake' | 'getNextWakeTime' | 'waitForIdle' | 'onWakeTimeChange'
>;

/**
 * @public
 * Asks for the alarm at `at`, epoch ms, or for none: one part's say in an alarm
 * the host shares (`sharedAlarm(...).schedule(name)`).
 */
export type AlarmSchedule = (at: number | undefined) => Promise<void> | void;

interface AlarmWakeBase {
  harness: WakeableHarness;
  /** The clock the harness runs on, when it is not `Date.now`. */
  now?: () => number;
}

/** @public Options for `alarmWake`: the object's alarm, or a `schedule` the host merges. */
export type AlarmWakeOptions = AlarmWakeBase &
  (
    | {
        /** The object's storage, `ctx.storage`: the preset owns the alarm. */
        alarms: AlarmStorageLike;
        schedule?: never;
      }
    | {
        /** Where the preset says the time it wants; the host sets the alarm. */
        schedule: AlarmSchedule;
        alarms?: never;
      }
  );

/**
 * How long until the alarm tries again when, after a whole pass, something is still
 * due that the pass could not do: a schedule's event its source did not deliver.
 */
const RETRY_MS = 3e4;

/** @public What `alarmWake` returns. */
export interface AlarmWake {
  /**
   * Call from the object's `alarm()` handler, or from inside `sharedAlarm`'s
   * `alarm()`. Starts the harness, so a `cron()` source delivers the ticks that fell
   * due while nothing ran; wakes every parked or cut turn that is due; waits for
   * every turn to finish or park again; then asks for the next alarm. It does not
   * throw for a turn that failed: a throw would make the runtime retry the alarm,
   * and the failure is already on the turn. Resolves the ids of the threads it woke.
   */
  alarm(): Promise<string[]>;
  /** The time last asked for, epoch ms; undefined when none was, or none is wanted. */
  wantedAt(): number | undefined;
  /** Stop asking for alarms from the harness. */
  stop(): void;
}

/** @public What `sharedAlarm` returns. */
export interface SharedAlarm {
  /**
   * A `schedule` for one part of the object, named `name`, which `alarmWake` takes:
   * each call replaces that part's time.
   */
  schedule(name: string): AlarmSchedule;
  /** The earliest time any part wants, epoch ms, or undefined. */
  wantedAt(): number | undefined;
  /**
   * Call from the object's `alarm()` handler. Forgets every time that has come,
   * runs `handler`, in which each part does its work and says its next time again,
   * then sets the alarm to the earliest time any part wants, deleting it when none
   * does. A throw from `handler` still leaves the alarm set, and reaches the runtime,
   * which retries the alarm.
   */
  alarm(handler: () => Promise<void>): Promise<void>;
}

/** @public The part of a Durable Object's state `durableObjectHolder` reads: `ctx`. */
export interface DurableObjectStateLike {
  readonly id: {
    toString(): string;
  };
}

//#endregion

//#region Public API

/**
 * @public
 * Wake parked and cut turns from a Durable Object alarm. From here on the harness
 * keeps the object's alarm at its next wake time (a parked turn's deadline, a cut
 * turn's back-off, a `cron()` tick), and clears it when there is none: the first
 * time when the harness starts, then whenever the time changes. A turn that parks
 * or is cut does not answer until its alarm is set.
 *
 * Given `schedule` in place of `alarms`, it sets nothing itself: it says the time
 * it wants, and the host merges it with its own (`sharedAlarm`).
 *
 * @example
 * ```ts
 * export class Agent extends DurableObject {
 *   #harness = buildHarness(createDurableObjectStorage({ sql: this.ctx.storage.sql }));
 *   #wake = alarmWake({ harness: this.#harness, alarms: this.ctx.storage });
 *
 *   async alarm() {
 *     await this.#wake.alarm();
 *   }
 *
 *   async message(text: string, messageId: string) {
 *     await this.#harness.execute(text, { threadId: 'main', messageId });
 *     return this.#harness.getAgentResponse({ threadId: 'main' });
 *   }
 * }
 * ```
 */
export function alarmWake(options: AlarmWakeOptions): AlarmWake {
  const { harness } = options;
  let wanted: number | undefined;

  async function set(at: number | undefined): Promise<void> {
    wanted = at;
    if (options.schedule) {
      await options.schedule(at);
      return;
    }
    if (at === undefined) {
      await options.alarms.deleteAlarm();
      return;
    }
    await options.alarms.setAlarm(at);
  }

  const stop = harness.onWakeTimeChange(set);

  return {
    stop,
    wantedAt: () => wanted,
    async alarm(): Promise<string[]> {
      await harness.start();
      const woken = await harness.wake();
      // The handler is what keeps the object alive: stay until every turn has
      // finished or parked again.
      await harness.waitForIdle();
      // The alarm that fired is spent. Set it again even when the time did not
      // change, as when it fired early and nothing was due.
      const next = await harness.getNextWakeTime();
      const now = (options.now ?? Date.now)();
      // Still due after a pass that did all it could: an alarm set in the past
      // fires at once, and the object would spin. Try again in a while.
      await set(next !== undefined && next <= now ? now + RETRY_MS : next);
      return woken;
    },
  };
}

/**
 * @public
 * One Durable Object alarm shared by several parts of the object: the harness's
 * `alarmWake` and the object's own work. Each part says the time it wants through
 * its `schedule(name)`; the alarm is kept at the earliest.
 *
 * Outside `alarm()` a part's time only moves the stored alarm earlier: after the
 * isolate restarts, the other parts' times are no longer in memory, and an alarm
 * that fires early does no harm. Inside it, every part says its time again, and the
 * alarm is set to the earliest of them.
 *
 * @example
 * ```ts
 * export class Session extends DurableObject {
 *   #alarms = sharedAlarm(this.ctx.storage);
 *   #wake = alarmWake({ harness: this.#harness, schedule: this.#alarms.schedule('noetic') });
 *   #retries = this.#alarms.schedule('retries');
 *
 *   async alarm() {
 *     await this.#alarms.alarm(async () => {
 *       await this.#wake.alarm();
 *       await this.#retries(await this.retryWrites());
 *     });
 *   }
 * }
 * ```
 */
export function sharedAlarm(
  storage: SharedAlarmStorageLike,
  options?: {
    now?: () => number;
  },
): SharedAlarm {
  const wants = new Map<string, number>();
  let firing = false;
  const now = options?.now ?? Date.now;
  /** Storage updates, one at a time: each reads the alarm and then sets it. */
  let updating: Promise<void> = Promise.resolve();

  function earliest(): number | undefined {
    let first: number | undefined;
    for (const at of wants.values()) {
      first = first === undefined ? at : Math.min(first, at);
    }
    return first;
  }

  function inTurn(update: () => Promise<void>): Promise<void> {
    const next = updating.then(update);
    updating = next.catch(() => undefined);
    return next;
  }

  /** Outside the handler: bring the alarm forward when a part wants it sooner. */
  async function bringForward(): Promise<void> {
    const current = await storage.getAlarm();
    // Read after the await: a part may have asked meanwhile.
    const first = earliest();
    if (first === undefined) {
      return;
    }
    if (current === null || current > first) {
      await storage.setAlarm(first);
    }
  }

  /** After the handler: every part has said its time, so the earliest is the alarm. */
  async function settle(): Promise<void> {
    const first = earliest();
    if (first === undefined) {
      await storage.deleteAlarm();
      return;
    }
    await storage.setAlarm(first);
  }

  return {
    schedule: (name) => async (at) => {
      if (at === undefined) {
        wants.delete(name);
      } else {
        wants.set(name, at);
      }
      // Inside the handler the alarm is set once, when it has run.
      if (firing) {
        return;
      }
      await inTurn(bringForward);
    },
    wantedAt: earliest,
    async alarm(handler): Promise<void> {
      const at = now();
      for (const [name, wanted] of wants) {
        if (wanted <= at) {
          wants.delete(name);
        }
      }
      firing = true;
      let failure:
        | {
            error: unknown;
          }
        | undefined;
      try {
        await handler();
      } catch (error) {
        failure = {
          error,
        };
      }
      firing = false;
      try {
        await inTurn(settle);
      } catch (error) {
        // The handler's own failure is the one the runtime should hear.
        if (!failure) {
          throw error;
        }
        console.warn('[noetic] sharedAlarm could not set the alarm:', error);
      }
      if (failure) {
        throw failure.error;
      }
    },
  };
}

/**
 * @public
 * The lease holder name for a harness in a Durable Object: the object's id. One
 * instance of an object runs at a time, so the object that comes back after its
 * isolate died takes its threads' leases over at once, and finds a turn the dead
 * isolate was running due now, not one lease period later (spec 23 § One writer per
 * turn). Pass it as `environment.storage.lease.holder`.
 */
export function durableObjectHolder(state: DurableObjectStateLike): string {
  return state.id.toString();
}

//#endregion
