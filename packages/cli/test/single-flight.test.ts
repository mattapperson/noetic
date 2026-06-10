import { describe, expect, test } from 'bun:test';
import { createSingleFlight } from '../src/util/single-flight.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

describe('createSingleFlight', () => {
  test('second fn does not start until the first settles', async () => {
    const flight = createSingleFlight();
    const gate = deferred<string>();
    const events: string[] = [];

    const first = flight(async () => {
      events.push('first-start');
      const value = await gate.promise;
      events.push('first-end');
      return value;
    });
    const second = flight(async () => {
      events.push('second-start');
      return 'b';
    });

    // Give the second caller every chance to start early.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual([
      'first-start',
    ]);

    gate.resolve('a');
    expect(await first).toBe('a');
    expect(await second).toBe('b');
    expect(events).toEqual([
      'first-start',
      'first-end',
      'second-start',
    ]);
  });

  test('a rejected flight does not wedge the gate', async () => {
    const flight = createSingleFlight();
    const gate = deferred<string>();

    const first = flight(async () => gate.promise);
    const second = flight(async () => 'recovered');

    gate.reject(new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    expect(await second).toBe('recovered');
  });

  test('three stacked callers drain in order', async () => {
    const flight = createSingleFlight();
    const gates = [
      deferred<void>(),
      deferred<void>(),
      deferred<void>(),
    ];
    const events: string[] = [];

    const runs = gates.map((gate, i) =>
      flight(async () => {
        events.push(`start-${i}`);
        await gate.promise;
        events.push(`end-${i}`);
        return i;
      }),
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([
      'start-0',
    ]);
    gates[0]?.resolve();
    gates[1]?.resolve();
    gates[2]?.resolve();
    expect(await Promise.all(runs)).toEqual([
      0,
      1,
      2,
    ]);
    expect(events).toEqual([
      'start-0',
      'end-0',
      'start-1',
      'end-1',
      'start-2',
      'end-2',
    ]);
  });

  test('caller arriving after settle runs immediately with fresh state', async () => {
    const flight = createSingleFlight();
    expect(await flight(async () => 1)).toBe(1);
    expect(await flight(async () => 2)).toBe(2);
  });
});
