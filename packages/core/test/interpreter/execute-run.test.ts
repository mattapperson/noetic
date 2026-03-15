import { describe, it, expect, afterEach } from 'bun:test';
import { executeRun } from '../../src/interpreter/execute-run';
import { OrchidErrorImpl, isOrchidError } from '../../src/errors/orchid-error';
import type { StepRun } from '../../src/types/step';
import type { Context } from '../../src/types/context';

// Minimal mock context
const mockCtx = {} as Context;

// Safety net: ensure setTimeout is always restored
const _originalSetTimeout = globalThis.setTimeout;
afterEach(() => { globalThis.setTimeout = _originalSetTimeout; });

/** Patch setTimeout to capture delay values and execute callbacks instantly. */
function interceptDelays(): { delays: number[]; restore: () => void } {
  const delays: number[] = [];
  (globalThis as any).setTimeout = (fn: any, delay?: number, ...args: any[]) => {
    if (delay && delay > 0) delays.push(delay);
    return _originalSetTimeout(fn, 1, ...args);
  };
  return { delays, restore: () => { globalThis.setTimeout = _originalSetTimeout; } };
}

describe('executeRun', () => {
  it('calls execute function and returns output', async () => {
    const s: StepRun<string, number> = {
      kind: 'run',
      id: 'test',
      execute: async (input) => input.length,
    };
    const result = await executeRun(s, 'hello', mockCtx);
    expect(result).toBe(5);
  });

  it('passes context to execute function', async () => {
    let receivedCtx: any;
    const s: StepRun<string, string> = {
      kind: 'run',
      id: 'test',
      execute: async (input, ctx) => {
        receivedCtx = ctx;
        return input;
      },
    };
    await executeRun(s, 'test', mockCtx);
    expect(receivedCtx).toBe(mockCtx);
  });

  it('throws step_failed on error without retry', async () => {
    const s: StepRun<string, string> = {
      kind: 'run',
      id: 'failing',
      execute: async () => { throw new Error('boom'); },
    };
    try {
      await executeRun(s, 'test', mockCtx);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(isOrchidError(e)).toBe(true);
      const oe = (e as OrchidErrorImpl).orchidError;
      expect(oe.kind).toBe('step_failed');
      if (oe.kind === 'step_failed') {
        expect(oe.stepId).toBe('failing');
        expect(oe.cause.message).toBe('boom');
        expect(oe.retriesExhausted).toBe(false);
      }
    }
  });

  it('retries with fixed backoff', async () => {
    const { delays, restore } = interceptDelays();

    let attempts = 0;
    const s: StepRun<string, string> = {
      kind: 'run',
      id: 'retry-test',
      execute: async (input) => {
        attempts++;
        if (attempts < 3) throw new Error('not yet');
        return 'success';
      },
      retry: { maxAttempts: 3, backoff: 'fixed', initialDelay: 10 },
    };
    try {
      const result = await executeRun(s, 'test', mockCtx);
      expect(result).toBe('success');
      expect(attempts).toBe(3);
      // Fixed backoff: all delays should be 10
      expect(delays).toEqual([10, 10]);
    } finally {
      restore();
    }
  });

  it('retries with exponential backoff and exhausts', async () => {
    const { delays, restore } = interceptDelays();
    let attempts = 0;
    const s: StepRun<string, string> = {
      kind: 'run',
      id: 'exhaust-test',
      execute: async () => {
        attempts++;
        throw new Error('always fails');
      },
      retry: { maxAttempts: 3, backoff: 'exponential', initialDelay: 10 },
    };
    try {
      await executeRun(s, 'test', mockCtx);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(isOrchidError(e)).toBe(true);
      const oe = (e as OrchidErrorImpl).orchidError;
      expect(oe.kind).toBe('step_failed');
      if (oe.kind === 'step_failed') {
        expect(oe.retriesExhausted).toBe(true);
      }
      expect(attempts).toBe(3);
      expect(delays).toEqual([10, 20]);
    } finally {
      restore();
    }
  });

  it('caps exponential backoff delay at maxDelay', async () => {
    const { delays, restore } = interceptDelays();

    let attempts = 0;
    const s: StepRun<string, string> = {
      kind: 'run',
      id: 'cap-test',
      execute: async () => {
        attempts++;
        if (attempts < 5) throw new Error('fail');
        return 'ok';
      },
      retry: { maxAttempts: 5, backoff: 'exponential', initialDelay: 100, maxDelay: 500 },
    };
    try {
      await executeRun(s, 'test', mockCtx);
    } finally {
      restore();
    }
    // Delays: 100, 200, 400, 500 (capped from 800)
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(500);
    }
    expect(delays.length).toBeGreaterThan(0);
    expect(delays).toEqual([100, 200, 400, 500]);
  });

  it('defaults maxDelay to 30000', async () => {
    // With exponential backoff, delay = 100 * 2^attempt
    // For attempt 9: 100 * 512 = 51200, should be capped at 30000
    const { delays, restore } = interceptDelays();

    let attempts = 0;
    const s: StepRun<string, string> = {
      kind: 'run',
      id: 'default-cap-test',
      execute: async () => {
        attempts++;
        if (attempts < 11) throw new Error('fail');
        return 'ok';
      },
      retry: { maxAttempts: 11, backoff: 'exponential', initialDelay: 100 },
    };
    try {
      await executeRun(s, 'test', mockCtx);
    } finally {
      restore();
    }
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(30_000);
    }
    expect(delays.length).toBeGreaterThan(0);
  });

  it('retries with linear backoff', async () => {
    const { delays, restore } = interceptDelays();

    let attempts = 0;
    const s: StepRun<string, string> = {
      kind: 'run',
      id: 'linear-test',
      execute: async () => {
        attempts++;
        if (attempts < 3) throw new Error('not yet');
        return 'ok';
      },
      retry: { maxAttempts: 3, backoff: 'linear', initialDelay: 10 },
    };
    try {
      const result = await executeRun(s, 'test', mockCtx);
      expect(result).toBe('ok');
      expect(attempts).toBe(3);
      // Linear backoff: delay = initialDelay * attempt
      expect(delays).toEqual([10, 20]);
    } finally {
      restore();
    }
  });

  it('wraps non-Error throws in OrchidErrorImpl', async () => {
    const s: StepRun<string, string> = {
      kind: 'run',
      id: 'string-throw',
      execute: async () => { throw 'string error'; },
    };
    try {
      await executeRun(s, 'test', mockCtx);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(isOrchidError(e)).toBe(true);
      const oe = (e as OrchidErrorImpl).orchidError;
      expect(oe.kind).toBe('step_failed');
    }
  });
});
