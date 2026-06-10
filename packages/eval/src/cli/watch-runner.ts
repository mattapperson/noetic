//#region Types

export interface WatchRunnerOpts {
  /** Spawns one child eval run and resolves with its exit code. */
  runChild: () => Promise<number>;
  /** Called with each completed child's exit code (reporting only — the watcher itself always exits 0). */
  onExit?: (code: number) => void;
}

export interface WatchRunner {
  /** Request a run. Triggers while a run is in flight coalesce into ONE follow-up run. */
  trigger(): void;
  /** Resolves once no run is in flight and nothing is pending. */
  settle(): Promise<void>;
}

//#endregion

//#region Public API

/**
 * Strip `--watch` from a raw argv so the spawned child performs a single run.
 * Everything else (the `test` subcommand, file patterns, flags) is preserved.
 */
export function buildChildArgs(argv: string[]): string[] {
  return argv.filter((arg) => arg !== '--watch');
}

/**
 * Serializes child eval runs. Watch mode spawns a FRESH subprocess per run
 * because in-process re-`import()` is module-cached under Bun: the eval file
 * bodies would never re-execute, so re-runs would register zero suites.
 * File changes during a run coalesce into exactly one follow-up run; children
 * are never killed mid-run.
 */
export function createWatchRunner(opts: WatchRunnerOpts): WatchRunner {
  let running = false;
  let pending = false;
  const settleWaiters: Array<() => void> = [];

  function notifySettled(): void {
    const waiters = settleWaiters.splice(0, settleWaiters.length);
    for (const waiter of waiters) {
      waiter();
    }
  }

  async function loop(): Promise<void> {
    running = true;
    do {
      pending = false;
      try {
        const code = await opts.runChild();
        opts.onExit?.(code);
      } catch (err) {
        // A spawn failure must not kill the watcher.
        console.error(err);
      }
    } while (pending);
    running = false;
    notifySettled();
  }

  return {
    trigger(): void {
      if (running) {
        pending = true;
        return;
      }
      void loop();
    },
    settle(): Promise<void> {
      if (!running) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        settleWaiters.push(resolve);
      });
    },
  };
}

//#endregion
