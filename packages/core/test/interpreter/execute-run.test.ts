import { describe, it, expect } from 'bun:test';
import { executeRun } from '../../src/interpreter/execute-run';
import { OrchidErrorImpl, isOrchidError } from '../../src/errors/orchid-error';
import type { StepRun } from '../../src/types/step';
import type { Context } from '../../src/types/context';

// Minimal mock context
const mockCtx = {} as Context;

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
      expect(true).toBe(false); // should not reach
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
    const result = await executeRun(s, 'test', mockCtx);
    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('retries with exponential backoff and exhausts', async () => {
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
      expect(true).toBe(false);
    } catch (e) {
      expect(isOrchidError(e)).toBe(true);
      const oe = (e as OrchidErrorImpl).orchidError;
      if (oe.kind === 'step_failed') {
        expect(oe.retriesExhausted).toBe(true);
      }
      expect(attempts).toBe(3);
    }
  });

  it('caps exponential backoff delay at maxDelay', async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    // Monkey-patch setTimeout to capture delays
    const patched = (fn: any, delay?: number, ...args: any[]) => {
      if (delay && delay > 0) delays.push(delay);
      return originalSetTimeout(fn, 1, ...args); // execute quickly
    };
    (globalThis as any).setTimeout = patched;

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
      globalThis.setTimeout = originalSetTimeout;
    }
    // Delays: 100, 200, 400, 500 (capped from 800)
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(500);
    }
  });

  it('defaults maxDelay to 30000', async () => {
    // With exponential backoff, delay = 100 * 2^attempt
    // For attempt 9: 100 * 512 = 51200, should be capped at 30000
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const patched = (fn: any, delay?: number, ...args: any[]) => {
      if (delay && delay > 0) delays.push(delay);
      return originalSetTimeout(fn, 1, ...args);
    };
    (globalThis as any).setTimeout = patched;

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
      globalThis.setTimeout = originalSetTimeout;
    }
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });

  it('retries with linear backoff', async () => {
    let attempts = 0;
    const s: StepRun<string, string> = {
      kind: 'run',
      id: 'linear-test',
      execute: async () => {
        attempts++;
        if (attempts < 2) throw new Error('not yet');
        return 'ok';
      },
      retry: { maxAttempts: 3, backoff: 'linear', initialDelay: 10 },
    };
    const result = await executeRun(s, 'test', mockCtx);
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });
});
