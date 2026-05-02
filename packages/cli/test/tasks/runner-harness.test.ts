import { describe, expect, it } from 'bun:test';

import { createRunnerSignal } from '../../src/commands/builtins/tasks/runner-harness.js';

describe('runner-harness', () => {
  describe('createRunnerSignal', () => {
    it('resolves with the value passed to resolve()', async () => {
      const signal = createRunnerSignal<{
        readonly status: 'completed';
      }>();
      signal.resolve({
        status: 'completed',
      });
      const outcome = await signal.done;
      expect(outcome).toEqual({
        status: 'completed',
      });
    });

    it('rejects with the value passed to reject()', async () => {
      const signal = createRunnerSignal<unknown>();
      const err = new Error('boom');
      signal.reject(err);
      await expect(signal.done).rejects.toBe(err);
    });

    it('is single-shot — second resolve after first is ignored', async () => {
      const signal = createRunnerSignal<number>();
      signal.resolve(1);
      signal.resolve(2);
      const v = await signal.done;
      expect(v).toBe(1);
    });

    it('is single-shot — reject after resolve is ignored', async () => {
      const signal = createRunnerSignal<number>();
      signal.resolve(7);
      signal.reject(new Error('late reject'));
      const v = await signal.done;
      expect(v).toBe(7);
    });

    it('is single-shot — resolve after reject is ignored', async () => {
      const signal = createRunnerSignal<number>();
      const err = new Error('first');
      signal.reject(err);
      signal.resolve(99);
      await expect(signal.done).rejects.toBe(err);
    });
  });
});
