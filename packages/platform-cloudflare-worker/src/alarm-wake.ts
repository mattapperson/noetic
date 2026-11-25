/**
 * The alarm preset (spec 25 § Cloudflare Workers): a Durable Object's alarm wakes
 * the harness's parked turns, and the harness sets the next alarm itself, through
 * `harness.onWakeTimeChange()`.
 *
 * A Worker has no process between requests, so the harness's own timers
 * (`park.autoWake`) cannot be relied on. Build the harness with
 * `park: { autoWake: false }` and let the alarm do it.
 */

import type { AgentHarness } from '@noetic-tools/core';

//#region Types

/** @public The part of a Durable Object's storage the alarm preset uses: `ctx.storage`. */
export interface AlarmStorageLike {
  setAlarm(scheduledTime: number): Promise<void> | void;
  deleteAlarm(): Promise<void> | void;
}

/** @public The harness methods the alarm preset calls. An `AgentHarness` fits. */
export type WakeableHarness = Pick<
  AgentHarness,
  'start' | 'wake' | 'getNextWakeTime' | 'waitForIdle' | 'onWakeTimeChange'
>;

/** @public Options for `alarmWake`. */
export interface AlarmWakeOptions {
  harness: WakeableHarness;
  /** The object's storage: `ctx.storage`. */
  alarms: AlarmStorageLike;
  /** The clock the harness runs on, when it is not `Date.now`. */
  now?: () => number;
}

/**
 * How long until the alarm tries again when, after a whole pass, something is still
 * due that the pass could not do: a schedule's event its source did not deliver.
 */
const RETRY_MS = 3e4;

/** @public What `alarmWake` returns. */
export interface AlarmWake {
  /**
   * Call from the object's `alarm()` handler. Starts the harness, so a `cron()`
   * source delivers the ticks that fell due while nothing ran; wakes every parked
   * turn that is due; waits for every turn to finish or park again; then sets the
   * next alarm. It does not throw for a turn that failed: a throw would make the
   * runtime retry the alarm, and the failure is already on the turn. Resolves the
   * ids of the parked threads it woke.
   */
  alarm(): Promise<string[]>;
  /** Stop setting the alarm from the harness. */
  stop(): void;
}

//#endregion

//#region Public API

/**
 * @public
 * Wake parked turns from a Durable Object alarm. From here on the harness keeps
 * the object's alarm at its next wake time (a parked turn's deadline or a `cron()`
 * tick), and clears it when there is none: the first time when the harness starts,
 * then whenever the time changes. A turn that parks does not answer until its
 * alarm is set.
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
  const { harness, alarms } = options;

  async function set(at: number | undefined): Promise<void> {
    if (at === undefined) {
      await alarms.deleteAlarm();
      return;
    }
    await alarms.setAlarm(at);
  }

  const stop = harness.onWakeTimeChange(set);

  return {
    stop,
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

//#endregion
