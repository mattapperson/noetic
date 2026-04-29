import { describe, expect, test } from 'bun:test';

import type { JobDefinition } from '../src/daemon-runtime/jobs.js';
import { JobScheduler } from '../src/daemon-runtime/jobs.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolveFn: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolveFn = res;
  });
  return {
    promise,
    resolve: resolveFn,
  };
}

describe('JobScheduler', () => {
  test('runOnce executes every job exactly once', async () => {
    const calls: string[] = [];
    const jobs: JobDefinition[] = [
      {
        id: 'a',
        intervalMs: 60_000,
        run: async () => {
          calls.push('a');
        },
      },
      {
        id: 'b',
        intervalMs: 60_000,
        run: async () => {
          calls.push('b');
        },
      },
    ];
    const scheduler = new JobScheduler(jobs, {
      cwd: process.cwd(),
    });
    await scheduler.runOnce();
    scheduler.stop();
    expect(calls).toEqual([
      'a',
      'b',
    ]);
  });

  test('errors in one job do not prevent other jobs from running', async () => {
    const calls: string[] = [];
    const jobs: JobDefinition[] = [
      {
        id: 'failing',
        intervalMs: 60_000,
        run: async () => {
          throw new Error('boom');
        },
      },
      {
        id: 'after',
        intervalMs: 60_000,
        run: async () => {
          calls.push('after');
        },
      },
    ];
    const scheduler = new JobScheduler(jobs, {
      cwd: process.cwd(),
    });
    await scheduler.runOnce();
    scheduler.stop();
    expect(calls).toEqual([
      'after',
    ]);
  });

  test('non-Error thrown values are caught', async () => {
    const jobs: JobDefinition[] = [
      {
        id: 'bad',
        intervalMs: 60_000,
        run: async () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'literal-string-error';
        },
      },
    ];
    const scheduler = new JobScheduler(jobs, {
      cwd: process.cwd(),
    });
    await scheduler.runOnce();
    scheduler.stop();
  });

  test('skips re-entrant ticks while a previous tick is still running', async () => {
    const gate = deferred<void>();
    let inFlight = 0;
    let started = 0;
    const job: JobDefinition = {
      id: 'slow',
      intervalMs: 60_000,
      run: async () => {
        started += 1;
        inFlight += 1;
        try {
          await gate.promise;
        } finally {
          inFlight -= 1;
        }
      },
    };
    const scheduler = new JobScheduler(
      [
        job,
      ],
      {
        cwd: process.cwd(),
      },
    );
    const first = scheduler.runOnce();
    const second = scheduler.runOnce();
    expect(inFlight).toBe(1);
    expect(started).toBe(1);
    gate.resolve();
    await Promise.all([
      first,
      second,
    ]);
    scheduler.stop();
    expect(started).toBe(1);
  });

  test('runOnStart=false skips the initial tick on start()', async () => {
    let runs = 0;
    const job: JobDefinition = {
      id: 'lazy',
      intervalMs: 60_000,
      runOnStart: false,
      run: async () => {
        runs += 1;
      },
    };
    const scheduler = new JobScheduler(
      [
        job,
      ],
      {
        cwd: process.cwd(),
      },
    );
    await scheduler.start();
    scheduler.stop();
    expect(runs).toBe(0);
  });

  test('runOnStart=true runs each job once before scheduling intervals', async () => {
    let runs = 0;
    const job: JobDefinition = {
      id: 'eager',
      intervalMs: 60_000,
      runOnStart: true,
      run: async () => {
        runs += 1;
      },
    };
    const scheduler = new JobScheduler(
      [
        job,
      ],
      {
        cwd: process.cwd(),
      },
    );
    await scheduler.start();
    scheduler.stop();
    expect(runs).toBe(1);
  });
});
