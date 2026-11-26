import type { StorageAdapter } from '@noetic-tools/core';

/** @public The fields Cloudflare passes to the Worker's scheduled handler. */
export interface CronTick {
  cron: string;
  scheduledTime: number;
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

interface State {
  done: number;
  lease?: {
    id: string;
    until: number;
  };
}

// A Cron Trigger invocation can live for up to 15 minutes.
const LEASE_MS = 16 * 60_000;

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
