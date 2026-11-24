/**
 * The alarm preset (spec 25 § Cloudflare Workers): a Durable Object's alarm wakes
 * the harness's parked turns, and the next alarm is set from `harness.nextWake()`.
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
export type WakeableHarness = Pick<AgentHarness, 'wake' | 'nextWake' | 'getAgentResponse'>;

/** @public Options for `alarmWake`. */
export interface AlarmWakeOptions {
  harness: WakeableHarness;
  /** The object's storage: `ctx.storage`. */
  alarms: AlarmStorageLike;
}

/** @public What `alarmWake` returns. */
export interface AlarmWake {
  /**
   * Call from the object's `alarm()` handler. Wakes every turn that is due, waits
   * for each to finish or park again, then sets the next alarm. It does not throw
   * for a turn that failed: a throw would make the runtime retry the alarm, and
   * the failure is already on the turn. Resolves the ids of the threads it woke.
   */
  alarm(): Promise<string[]>;
  /**
   * Set the alarm to the harness's next wake time, or clear it when nothing is
   * parked. Call after a turn you ran yourself has answered, since it may have
   * parked.
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
    const at = await harness.nextWake();
    if (at === undefined) {
      await alarms.deleteAlarm();
      return;
    }
    await alarms.setAlarm(at);
  }

  return {
    schedule,
    async alarm(): Promise<string[]> {
      const woken = await harness.wake();
      // The handler is what keeps the object alive: stay until each turn has
      // finished or parked again.
      await Promise.allSettled(
        woken.map((threadId) =>
          harness.getAgentResponse({
            threadId,
          }),
        ),
      );
      await schedule();
      return woken;
    },
  };
}

//#endregion
