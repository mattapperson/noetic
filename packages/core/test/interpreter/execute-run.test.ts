import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import type { Context, RetryPolicy, StepRunCode } from '@noetic-tools/types';
import { isNoeticError, NoeticErrorImpl } from '@noetic-tools/types';
import { computeRetryDelay, executeRunCode } from '../../src/interpreter/execute-action';
import { ContextImpl } from '../../src/runtime/context-impl';
import { makeMockContext, makeMockHarness } from '../_helpers';

const mockCtx: Context = makeMockContext();

describe('executeRunCode', () => {
  it('calls execute function and returns output', async () => {
    const s: StepRunCode<ContextData, string, number> = {
      kind: 'runCode',
      id: 'test',
      execute: async (input) => input.length,
    };
    const result = await executeRunCode(s, 'hello', mockCtx);
    expect(result).toBe(5);
  });

  it('passes context to execute function', async () => {
    let receivedCtx: Context | undefined;
    const s: StepRunCode<ContextData, string, string> = {
      kind: 'runCode',
      id: 'test',
      execute: async (input, ctx) => {
        receivedCtx = ctx;
        return input;
      },
    };
    await executeRunCode(s, 'test', mockCtx);
    expect(receivedCtx).toBe(mockCtx);
  });

  it('throws step_failed on error without retry', async () => {
    const s: StepRunCode<ContextData, string, string> = {
      kind: 'runCode',
      id: 'failing',
      execute: async () => {
        throw new Error('boom');
      },
    };
    try {
      await executeRunCode(s, 'test', mockCtx);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      const oe = e.noeticError;
      assert(oe.kind === 'step_failed');
      expect(oe.stepId).toBe('failing');
      expect(oe.cause.message).toBe('boom');
      expect(oe.retriesExhausted).toBe(false);
    }
  });

  it('retries with fixed backoff', async () => {
    let attempts = 0;
    const retry: RetryPolicy = {
      maxAttempts: 3,
      backoff: 'fixed',
      initialDelay: 1,
    };
    const step: StepRunCode<ContextData, string, string> = {
      kind: 'runCode',
      id: 'retry-test',
      retry,
      execute: async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('not yet');
        }
        return 'success';
      },
    };
    expect(await executeRunCode(step, 'test', mockCtx)).toBe('success');
    expect(attempts).toBe(3);
    expect(
      [
        0,
        1,
      ].map((attempt) => computeRetryDelay(retry, attempt)),
    ).toEqual([
      1,
      1,
    ]);
  });

  it('retries with exponential backoff and exhausts', async () => {
    let attempts = 0;
    const retry: RetryPolicy = {
      maxAttempts: 3,
      backoff: 'exponential',
      initialDelay: 1,
    };
    const step: StepRunCode<ContextData, string, string> = {
      kind: 'runCode',
      id: 'exhaust-test',
      retry,
      execute: async () => {
        attempts++;
        throw new Error('always fails');
      },
    };
    await expect(executeRunCode(step, 'test', mockCtx)).rejects.toThrow('always fails');
    expect(attempts).toBe(3);
    expect(
      [
        0,
        1,
      ].map((attempt) => computeRetryDelay(retry, attempt)),
    ).toEqual([
      1,
      2,
    ]);
  });

  it('caps exponential backoff delay at maxDelay', () => {
    const retry: RetryPolicy = {
      maxAttempts: 5,
      backoff: 'exponential',
      initialDelay: 100,
      maxDelay: 500,
    };
    expect(
      [
        0,
        1,
        2,
        3,
      ].map((attempt) => computeRetryDelay(retry, attempt)),
    ).toEqual([
      100,
      200,
      400,
      500,
    ]);
  });

  it('defaults maxDelay to 30000', () => {
    const retry: RetryPolicy = {
      maxAttempts: 11,
      backoff: 'exponential',
      initialDelay: 100,
    };
    expect(computeRetryDelay(retry, 9)).toBe(30_000);
  });

  it('retries with linear backoff', async () => {
    let attempts = 0;
    const retry: RetryPolicy = {
      maxAttempts: 3,
      backoff: 'linear',
      initialDelay: 1,
    };
    const step: StepRunCode<ContextData, string, string> = {
      kind: 'runCode',
      id: 'linear-test',
      retry,
      execute: async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('not yet');
        }
        return 'ok';
      },
    };
    expect(await executeRunCode(step, 'test', mockCtx)).toBe('ok');
    expect(attempts).toBe(3);
    expect(
      [
        0,
        1,
      ].map((attempt) => computeRetryDelay(retry, attempt)),
    ).toEqual([
      1,
      2,
    ]);
  });

  describe('cancellation (not retriable)', () => {
    it('rethrows cancelled immediately without consuming retry attempts', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      let attempts = 0;
      const s: StepRunCode<ContextData, string, string> = {
        kind: 'runCode',
        id: 'cancel-test',
        execute: async () => {
          attempts++;
          throw new NoeticErrorImpl({
            kind: 'cancelled',
            reason: 'user dismissed dialog',
          });
        },
        retry: {
          maxAttempts: 3,
          backoff: 'fixed',
          initialDelay: 1,
        },
      };
      try {
        await executeRunCode(s, 'test', ctx);
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        const oe = e.noeticError;
        assert(oe.kind === 'cancelled');
        expect(oe.reason).toBe('user dismissed dialog');
      }
      expect(attempts).toBe(1);
      expect(ctx.itemLog.items).toHaveLength(0);
    });

    it('throws cancelled before re-executing when the context aborts between attempts', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      let attempts = 0;
      const s: StepRunCode<ContextData, string, string> = {
        kind: 'runCode',
        id: 'abort-between',
        execute: async () => {
          attempts++;
          // Simulate an abort arriving while the first attempt is failing.
          ctx.abort('shutting down');
          throw new Error('transient');
        },
        retry: {
          maxAttempts: 3,
          backoff: 'fixed',
          initialDelay: 1,
        },
      };
      try {
        await executeRunCode(s, 'test', ctx);
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        const oe = e.noeticError;
        assert(oe.kind === 'cancelled');
        expect(oe.reason).toBe('shutting down');
      }
      // The second attempt never ran — the top-of-attempt abort check fired.
      expect(attempts).toBe(1);
      expect(ctx.itemLog.items).toHaveLength(0);
    });
  });

  describe('retry attempt boundaries (maxAttempts = 3)', () => {
    function failUntil(succeedOnAttempt: number): {
      step: StepRunCode<ContextData, string, string>;
      attempts: () => number;
    } {
      let attempts = 0;
      return {
        step: {
          kind: 'runCode',
          id: `boundary-${succeedOnAttempt}`,
          execute: async () => {
            attempts++;
            if (attempts < succeedOnAttempt) {
              throw new Error('not yet');
            }
            return 'ok';
          },
          retry: {
            maxAttempts: 3,
            backoff: 'fixed',
            initialDelay: 1,
          },
        },
        attempts: () => attempts,
      };
    }

    it('succeeds on attempt N-1 (2 of 3)', async () => {
      const { step: s, attempts } = failUntil(2);
      expect(await executeRunCode(s, 'test', mockCtx)).toBe('ok');
      expect(attempts()).toBe(2);
    });

    it('succeeds on attempt N (3 of 3)', async () => {
      const { step: s, attempts } = failUntil(3);
      expect(await executeRunCode(s, 'test', mockCtx)).toBe('ok');
      expect(attempts()).toBe(3);
    });

    it('fails when success would come on attempt N+1 (4 of 3)', async () => {
      const { step: s, attempts } = failUntil(4);
      try {
        await executeRunCode(s, 'test', mockCtx);
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        const oe = e.noeticError;
        assert(oe.kind === 'step_failed');
        expect(oe.retriesExhausted).toBe(true);
      }
      expect(attempts()).toBe(3);
    });
  });

  it('wraps non-Error throws in NoeticErrorImpl', async () => {
    const s: StepRunCode<ContextData, string, string> = {
      kind: 'runCode',
      id: 'string-throw',
      execute: async () => {
        throw 'string error';
      },
    };
    try {
      await executeRunCode(s, 'test', mockCtx);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('step_failed');
    }
  });
});
