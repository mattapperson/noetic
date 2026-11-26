/**
 * Cloudflare Cron Triggers as wakes for durable work (spec 25 § Cron Triggers):
 * `cronWake` scans work that keeps its own cursor, and `cronTurn` gives each tick
 * to a Durable Object's harness as a message.
 */

import type {
  AgentHarness,
  ExecuteInput,
  ExecuteOptions,
  StorageAdapter,
} from '@noetic-tools/core';
import type { AlarmWake } from './alarm-wake';

//#region Types

/** @public The fields Cloudflare passes to the Worker's scheduled handler. */
export interface CronTick {
  cron: string;
  scheduledTime: number;
}

/** @public Options for a harness turn per cron tick. */
export interface CronTurnOptions {
  cron: string;
  /** Unique among the harness's cron jobs. */
  name: string;
  /** The harness the object's other messages go to. */
  harness: Pick<AgentHarness, 'execute' | 'getAgentResponse'>;
  /** The object's alarm preset, over the same harness. */
  wake: Pick<AlarmWake, 'alarm'>;
  /** What the turn is given. */
  input: ExecuteInput | ((tick: CronTick) => ExecuteInput);
  /** `execute()` options other than the identity and delivery mode the preset sets. */
  options?: Omit<ExecuteOptions, 'threadId' | 'messageId' | 'deliveryMode'>;
}

/** @public Options for a periodic scan of durable work. */
export interface CronWakeOptions<Env> {
  cron: string;
  /** Unique among cron jobs sharing the same storage. */
  name: string;
  storage(env: Env): StorageAdapter;
  /** Scan for all due work. It may be called again after a partial pass. */
  run(env: Env, through: number): Promise<void>;
  /** The wall clock, in milliseconds. */
  now?: () => number;
}

//#endregion

//#region Public API

/**
 * @public
 * Give each Cloudflare cron tick to a Durable Object's harness as one message, by
 * the same `harness.execute()` the object's requests use. Route the Worker's
 * `scheduled` handler to a method of the named object, and call this there.
 *
 * Each tick owns the thread and message id `cron:<name>:<scheduledTime>`. A later
 * tick cannot replace its checkpoint or evict its completed receipt. Queued delivery
 * lets a duplicate join the active turn. The alarm pass wakes due work before
 * delivery. The tick's own response keeps the handler alive until it settles,
 * parks or cuts. A failed response rejects the handler so its caller can report
 * or retry that tick.
 *
 * @example
 * ```ts
 * export class Agent extends DurableObject {
 *   #harness = buildHarness(durableObjectEnvironment(this.ctx));
 *   #wake = alarmWake({ harness: this.#harness, alarms: this.ctx.storage });
 *   #digest = cronTurn({
 *     cron: '0 8 * * *',
 *     name: 'digest',
 *     harness: this.#harness,
 *     wake: this.#wake,
 *     input: 'Write the morning digest.',
 *   });
 *
 *   async alarm() {
 *     await this.#wake.alarm();
 *   }
 *
 *   async tick(tick: CronTick) {
 *     await this.#digest(tick);
 *   }
 * }
 *
 * export default {
 *   async scheduled(controller, env) {
 *     await env.AGENT.getByName('main').tick({
 *       cron: controller.cron,
 *       scheduledTime: controller.scheduledTime,
 *     });
 *   },
 * };
 * ```
 */
export function cronTurn(options: CronTurnOptions): (tick: CronTick) => Promise<void> {
  const { harness, wake, input } = options;
  return async (tick) => {
    if (tick.cron !== options.cron) {
      return;
    }
    await wake.alarm();
    const id = `cron:${options.name}:${tick.scheduledTime}`;
    await harness.execute(typeof input === 'function' ? input(tick) : input, {
      ...options.options,
      threadId: id,
      messageId: id,
      deliveryMode: 'next-turn',
    });
    await harness.getAgentResponse({
      threadId: id,
    });
  };
}

/**
 * @public
 * Turn Cloudflare cron ticks into scans of durable work. A successful scan covers
 * earlier ticks too. Duplicate or concurrent delivery does not start another scan.
 * The next tick can retry a failed scan, and can take over after a lost Worker’s
 * lease expires. Keep the work's own cursor and use stable keys for its effects.
 */
export function cronWake<Env>(
  options: CronWakeOptions<Env>,
): (tick: CronTick, env: Env) => Promise<void> {
  const key = `noetic/cron/${options.name}`;
  const now = options.now ?? Date.now;
  return async (tick, env) => {
    if (tick.cron !== options.cron) {
      return;
    }
    const store = options.storage(env);
    if (!store.swap) {
      throw new Error('cronWake needs storage with swap');
    }
    const state = await store.get<State>(key);
    const done = state?.done ?? -1;
    const at = now();
    if (done >= tick.scheduledTime || (state?.lease && state.lease.until > at)) {
      return;
    }
    const claim: State = {
      done,
      lease: {
        id: crypto.randomUUID(),
        until: at + LEASE_MS,
      },
    };
    if (!(await store.swap(key, state, claim))) {
      return;
    }
    let through = done;
    try {
      await options.run(env, tick.scheduledTime);
      through = tick.scheduledTime;
    } finally {
      await store.swap(key, claim, {
        done: through,
      });
    }
  };
}

//#endregion

//#region Scan state

interface State {
  done: number;
  lease?: {
    id: string;
    until: number;
  };
}

// A Cron Trigger invocation can live for up to 15 minutes.
const LEASE_MS = 16 * 60_000;

//#endregion
