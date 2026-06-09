import { describe, expect, it } from 'bun:test';

import { createDetachedSignal } from '../../src/runtime/durable/detached-signal';

describe('createDetachedSignal', () => {
  it('resolves .done with the first outcome passed', async () => {
    const signal = createDetachedSignal<number>();
    signal.resolve(42);
    await expect(signal.done).resolves.toBe(42);
  });

  it('rejects .done with the first reason passed', async () => {
    const signal = createDetachedSignal<number>();
    const err = new Error('boom');
    signal.reject(err);
    await expect(signal.done).rejects.toBe(err);
  });

  it('drops a second resolve after the first (single-shot)', async () => {
    const signal = createDetachedSignal<number>();
    signal.resolve(1);
    signal.resolve(2);
    await expect(signal.done).resolves.toBe(1);
  });

  it('drops a reject after a resolve', async () => {
    const signal = createDetachedSignal<number>();
    signal.resolve(7);
    signal.reject(new Error('ignored'));
    await expect(signal.done).resolves.toBe(7);
  });

  it('drops a resolve after a reject', async () => {
    const signal = createDetachedSignal<number>();
    const err = new Error('first');
    signal.reject(err);
    signal.resolve(9);
    await expect(signal.done).rejects.toBe(err);
  });
});
