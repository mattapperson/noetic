import { describe, expect, test } from 'bun:test';
import { abortableIterable } from '../src/util/abortable-iterable.js';

/** An async iterable whose values are pushed manually; tracks return(). */
function makeSource<T>(): {
  iterable: AsyncIterable<T>;
  push: (value: T) => void;
  end: () => void;
  fail: (err: Error) => void;
  returnCalls: () => number;
} {
  type Waiter = {
    resolve: (r: IteratorResult<T>) => void;
    reject: (e: Error) => void;
  };
  const queue: T[] = [];
  const waiters: Waiter[] = [];
  let done = false;
  let error: Error | null = null;
  let returnCount = 0;

  const settleWaiters = (): void => {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter) {
        break;
      }
      if (error !== null) {
        waiter.reject(error);
        continue;
      }
      const value = queue.shift();
      if (value !== undefined) {
        waiter.resolve({
          done: false,
          value,
        });
        continue;
      }
      if (done) {
        waiter.resolve({
          done: true,
          value: undefined,
        });
        continue;
      }
      waiters.unshift(waiter);
      break;
    }
  };

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<T>>((resolve, reject) => {
          waiters.push({
            resolve,
            reject,
          });
          settleWaiters();
        }),
      return: () => {
        returnCount += 1;
        done = true;
        settleWaiters();
        return Promise.resolve({
          done: true,
          value: undefined,
        } satisfies IteratorResult<T>);
      },
    }),
  };

  return {
    iterable,
    push: (value) => {
      queue.push(value);
      settleWaiters();
    },
    end: () => {
      done = true;
      settleWaiters();
    },
    fail: (err) => {
      error = err;
      settleWaiters();
    },
    returnCalls: () => returnCount,
  };
}

describe('abortableIterable', () => {
  test('passes values through and completes normally', async () => {
    const source = makeSource<number>();
    const controller = new AbortController();
    const seen: number[] = [];
    source.push(1);
    source.push(2);
    source.end();
    for await (const value of abortableIterable(source.iterable, controller.signal)) {
      seen.push(value);
    }
    expect(seen).toEqual([
      1,
      2,
    ]);
  });

  test('abort mid-iteration ends the loop and calls inner return()', async () => {
    const source = makeSource<number>();
    const controller = new AbortController();
    const seen: number[] = [];

    const run = (async (): Promise<void> => {
      for await (const value of abortableIterable(source.iterable, controller.signal)) {
        seen.push(value);
      }
    })();

    source.push(1);
    // Let the consumer park on the next next() before aborting.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();
    // Must resolve without throwing — abort is swallowed, not rethrown.
    await run;
    expect(seen).toEqual([
      1,
    ]);
    expect(source.returnCalls()).toBe(1);
  });

  test('real errors from the inner iterator are rethrown', async () => {
    const source = makeSource<number>();
    const controller = new AbortController();

    const run = (async (): Promise<number[]> => {
      const seen: number[] = [];
      for await (const value of abortableIterable(source.iterable, controller.signal)) {
        seen.push(value);
      }
      return seen;
    })();

    source.fail(new Error('stream blew up'));
    await expect(run).rejects.toThrow('stream blew up');
  });

  test('already-aborted signal yields nothing', async () => {
    const source = makeSource<number>();
    const controller = new AbortController();
    controller.abort();
    source.push(1);
    const seen: number[] = [];
    for await (const value of abortableIterable(source.iterable, controller.signal)) {
      seen.push(value);
    }
    expect(seen).toEqual([]);
  });

  test('consumer break still unhooks the inner iterator', async () => {
    const source = makeSource<number>();
    const controller = new AbortController();
    source.push(1);
    source.push(2);
    for await (const value of abortableIterable(source.iterable, controller.signal)) {
      if (value === 1) {
        break;
      }
    }
    expect(source.returnCalls()).toBe(1);
  });
});
