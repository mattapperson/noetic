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
