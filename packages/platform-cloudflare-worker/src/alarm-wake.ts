/**
 * The alarm preset (spec 25 § Cloudflare Workers): a Durable Object's alarm wakes
 * the harness's parked turns, and the next alarm is set from `harness.getNextWakeTime()`.
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
  'start' | 'wake' | 'getNextWakeTime' | 'waitForIdle'
>;

/** @public Options for `alarmWake`. */
export interface AlarmWakeOptions {
  harness: WakeableHarness;
  /** The object's storage: `ctx.storage`. */
  alarms: AlarmStorageLike;
}

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
  /**
   * Set the alarm to the harness's next wake time (a parked turn's deadline or a
   * `cron()` tick), or clear it when there is none. Call after a turn you ran
   * yourself has answered, since it may have parked, and once when the object is
   * first set up, so the first tick has an alarm.
   */
  schedule(): Promise<void>;
}

//#endregion

//#region Public API

/**
 * @public
 * Wake parked turns from a Durable Object alarm.
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
 *     const response = await this.#harness.getAgentResponse({ threadId: 'main' });
 *     await this.#wake.schedule();
 *     return response;
 *   }
 * }
 * ```
 */
export function alarmWake(options: AlarmWakeOptions): AlarmWake {
  const { harness, alarms } = options;

  async function schedule(): Promise<void> {
    // Started, so a scheduled source's next event is known.
    await harness.start();
    const at = await harness.getNextWakeTime();
    if (at === undefined) {
      await alarms.deleteAlarm();
      return;
    }
    await alarms.setAlarm(at);
  }

  return {
    schedule,
    async alarm(): Promise<string[]> {
      await harness.start();
      const woken = await harness.wake();
      // The handler is what keeps the object alive: stay until every turn has
      // finished or parked again.
      await harness.waitForIdle();
      await schedule();
      return woken;
    },
  };
}

//#endregion
