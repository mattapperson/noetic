import { describe, expect, test } from 'bun:test';

import { buildChildArgs, createWatchRunner } from '../../src/cli/watch-runner';

//#region Helper Functions

interface Deferred {
  promise: Promise<number>;
  resolve: (code: number) => void;
  reject: (err: Error) => void;
}

function deferred(): Deferred {
  let resolve: (code: number) => void = () => {};
  let reject: (err: Error) => void = () => {};
  const promise = new Promise<number>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

async function microtask(): Promise<void> {
  await Promise.resolve();
}

//#endregion

//#region buildChildArgs

describe('buildChildArgs', () => {
  test('strips --watch and keeps everything else in order', () => {
    expect(
      buildChildArgs([
        'test',
        '--watch',
        '--verbose',
        'support-agent',
      ]),
    ).toEqual([
      'test',
      '--verbose',
      'support-agent',
    ]);
  });

  test('no --watch present is a no-op', () => {
    expect(
      buildChildArgs([
        'test',
        'a.eval.ts',
      ]),
    ).toEqual([
      'test',
      'a.eval.ts',
    ]);
  });

  test('strips every occurrence of --watch', () => {
    expect(
      buildChildArgs([
        '--watch',
        '--watch',
      ]),
    ).toEqual([]);
  });
});

//#endregion

//#region createWatchRunner

describe('createWatchRunner', () => {
  test('runs once per trigger when idle and reports exit codes', async () => {
    const codes: number[] = [];
    let runs = 0;
    const runner = createWatchRunner({
      runChild: async () => {
        runs++;
        return 1;
      },
      onExit: (code) => {
        codes.push(code);
      },
    });

    runner.trigger();
    await runner.settle();

    expect(runs).toBe(1);
    expect(codes).toEqual([
      1,
    ]);
  });

  test('triggers during a run coalesce into exactly ONE follow-up run', async () => {
    const gates: Deferred[] = [];
    let runs = 0;
    const runner = createWatchRunner({
      runChild: () => {
        runs++;
        const gate = deferred();
        gates.push(gate);
        return gate.promise;
      },
    });

    runner.trigger();
    await microtask();
    expect(runs).toBe(1);

    // Three changes land while the first run is still in flight.
    runner.trigger();
    runner.trigger();
    runner.trigger();
    expect(runs).toBe(1);

    gates[0].resolve(0);
    const settled = runner.settle();
    await microtask();
    expect(runs).toBe(2);

    gates[1].resolve(0);
    await settled;
    expect(runs).toBe(2);
  });

  test('a rejected child run does not wedge the runner', async () => {
    let runs = 0;
    const runner = createWatchRunner({
      runChild: async () => {
        runs++;
        if (runs === 1) {
          throw new Error('spawn failed');
        }
        return 0;
      },
    });

    runner.trigger();
    await runner.settle();
    expect(runs).toBe(1);

    runner.trigger();
    await runner.settle();
    expect(runs).toBe(2);
  });

  test('settle resolves immediately when idle', async () => {
    const runner = createWatchRunner({
      runChild: async () => 0,
    });
    await runner.settle();
  });

  test('exit codes propagate per run, watcher decides nothing from them', async () => {
    const codes: number[] = [];
    let next = 0;
    const runner = createWatchRunner({
      runChild: async () => next++,
      onExit: (code) => {
        codes.push(code);
      },
    });

    runner.trigger();
    await runner.settle();
    runner.trigger();
    await runner.settle();

    expect(codes).toEqual([
      0,
      1,
    ]);
  });
});

//#endregion
