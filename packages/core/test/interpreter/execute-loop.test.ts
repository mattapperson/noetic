import { describe, it, expect } from 'bun:test';
import { executeLoop } from '../../src/interpreter/execute-loop';
import { until } from '../../src/until/predicates';
import { isOrchidError, OrchidErrorImpl } from '../../src/errors/orchid-error';
import type { StepLoop } from '../../src/types/step';
import type { Context } from '../../src/types/context';
import { ContextImpl } from '../../src/runtime/context-impl';

// Simple executeStep that handles 'run' kind
const simpleExecuteStep = async <I, O>(step: any, input: I, ctx: Context): Promise<O> => {
  if (step.kind === 'run') {
    return await step.execute(input, ctx);
  }
  throw new Error(`Unsupported step kind: ${step.kind}`);
};

describe('executeLoop', () => {
  it('repeats body until predicate fires', async () => {
    let count = 0;
    const loopStep: StepLoop<number, number> = {
      kind: 'loop',
      id: 'test-loop',
      body: {
        kind: 'run',
        id: 'inc',
        execute: async (input: number) => {
          count++;
          return input + 1;
        },
      },
      until: until.maxSteps(3),
    };

    const ctx = new ContextImpl();
    const result = await executeLoop(loopStep, 0, ctx, simpleExecuteStep);
    expect(count).toBe(3);
    expect(result).toBe(3); // 0+1=1, 1+1=2, 2+1=3
  });

  it('uses prepareNext to transform input between iterations', async () => {
    const inputs: string[] = [];
    const loopStep: StepLoop<string, string> = {
      kind: 'loop',
      id: 'prep-loop',
      body: {
        kind: 'run',
        id: 'echo',
        execute: async (input: string) => {
          inputs.push(input);
          return `result-${input}`;
        },
      },
      until: until.maxSteps(3),
      prepareNext: (output, verdict) => {
        if (verdict.feedback) return verdict.feedback;
        return 'next';
      },
    };

    const ctx = new ContextImpl();
    await executeLoop(loopStep, 'first', ctx, simpleExecuteStep);
    expect(inputs[0]).toBe('first');
    expect(inputs[1]).toBe('next');
    expect(inputs[2]).toBe('next');
  });

  it('onError retry re-runs same iteration', async () => {
    let attempts = 0;
    const loopStep: StepLoop<string, string> = {
      kind: 'loop',
      id: 'retry-loop',
      body: {
        kind: 'run',
        id: 'flaky',
        execute: async (input: string) => {
          attempts++;
          if (attempts <= 2) {
            throw new OrchidErrorImpl({
              kind: 'step_failed',
              stepId: 'flaky',
              cause: new Error('flaky'),
              retriesExhausted: false,
            });
          }
          return 'success';
        },
      },
      until: until.maxSteps(1),
      onError: () => 'retry',
    };

    const ctx = new ContextImpl();
    const result = await executeLoop(loopStep, 'go', ctx, simpleExecuteStep);
    expect(result).toBe('success');
    expect(attempts).toBe(3); // 2 failures + 1 success
  });

  it('onError skip uses last successful output', async () => {
    let callCount = 0;
    const loopStep: StepLoop<number, number> = {
      kind: 'loop',
      id: 'skip-loop',
      body: {
        kind: 'run',
        id: 'sometimes-fail',
        execute: async (input: number) => {
          callCount++;
          if (callCount === 2) {
            throw new OrchidErrorImpl({
              kind: 'step_failed',
              stepId: 'sometimes-fail',
              cause: new Error('oops'),
              retriesExhausted: false,
            });
          }
          return input + 1;
        },
      },
      until: until.maxSteps(3),
      onError: () => 'skip',
    };

    const ctx = new ContextImpl();
    const result = await executeLoop(loopStep, 0, ctx, simpleExecuteStep);
    // call 1: 0+1=1 (success), call 2: error (skip, use 1), call 3: 1+1=2 (success)
    expect(result).toBe(2);
  });

  it('onError abort propagates error', async () => {
    const loopStep: StepLoop<string, string> = {
      kind: 'loop',
      id: 'abort-loop',
      body: {
        kind: 'run',
        id: 'fail',
        execute: async () => {
          throw new OrchidErrorImpl({
            kind: 'step_failed',
            stepId: 'fail',
            cause: new Error('boom'),
            retriesExhausted: false,
          });
        },
      },
      until: until.maxSteps(5),
      onError: () => 'abort',
    };

    const ctx = new ContextImpl();
    try {
      await executeLoop(loopStep, 'go', ctx, simpleExecuteStep);
      expect(true).toBe(false);
    } catch (e) {
      expect(isOrchidError(e)).toBe(true);
    }
  });

  it('predicate throw treated as stop', async () => {
    let count = 0;
    const loopStep: StepLoop<number, number> = {
      kind: 'loop',
      id: 'pred-throw-loop',
      body: {
        kind: 'run',
        id: 'inc',
        execute: async (input: number) => {
          count++;
          return input + 1;
        },
      },
      until: () => {
        throw new Error('predicate boom');
      },
    };

    const ctx = new ContextImpl();
    const result = await executeLoop(loopStep, 0, ctx, simpleExecuteStep);
    expect(count).toBe(1); // runs once, predicate throws, stops
    expect(result).toBe(1);
  });

  it('snapshot population is correct', async () => {
    let capturedSnapshot: any = null;
    const loopStep: StepLoop<string, string> = {
      kind: 'loop',
      id: 'snap-loop',
      body: {
        kind: 'run',
        id: 'echo',
        execute: async (input: string) => `output-${input}`,
      },
      until: (snap) => {
        capturedSnapshot = snap;
        return { stop: snap.stepCount >= 1 };
      },
    };

    const ctx = new ContextImpl();
    await executeLoop(loopStep, 'test', ctx, simpleExecuteStep);

    expect(capturedSnapshot).not.toBeNull();
    expect(capturedSnapshot.stepCount).toBe(1);
    expect(capturedSnapshot.lastOutput).toBe('output-test');
    expect(capturedSnapshot.lastText).toBe('output-test');
    expect(capturedSnapshot.history).toHaveLength(1);
    expect(capturedSnapshot.depth).toBe(0);
  });

  it('enforces maxIterations ceiling', async () => {
    const loopStep: StepLoop<number, number> = {
      kind: 'loop',
      id: 'ceiling-loop',
      body: {
        kind: 'run',
        id: 'inc',
        execute: async (input: number) => input + 1,
      },
      until: () => ({ stop: false }), // never stops
      maxIterations: 5,
    };

    const ctx = new ContextImpl();
    try {
      await executeLoop(loopStep, 0, ctx, simpleExecuteStep);
      expect(true).toBe(false);
    } catch (e) {
      expect(isOrchidError(e)).toBe(true);
      const oe = (e as any).orchidError;
      expect(oe.kind).toBe('step_failed');
      expect(oe.cause.message).toContain('maximum iterations');
    }
  });

  it('default maxIterations is 1000', async () => {
    let count = 0;
    const loopStep: StepLoop<number, number> = {
      kind: 'loop',
      id: 'default-ceiling-loop',
      body: {
        kind: 'run',
        id: 'inc',
        execute: async (input: number) => {
          count++;
          return input + 1;
        },
      },
      until: () => ({ stop: false }), // never stops
    };

    const ctx = new ContextImpl();
    try {
      await executeLoop(loopStep, 0, ctx, simpleExecuteStep);
      expect(true).toBe(false);
    } catch (e) {
      expect(isOrchidError(e)).toBe(true);
      expect(count).toBe(1000);
    }
  });

  it('retry counts against maxIterations ceiling', async () => {
    let attempts = 0;
    const loopStep: StepLoop<string, string> = {
      kind: 'loop',
      id: 'retry-ceiling-loop',
      body: {
        kind: 'run',
        id: 'always-fail',
        execute: async () => {
          attempts++;
          throw new OrchidErrorImpl({
            kind: 'step_failed',
            stepId: 'always-fail',
            cause: new Error('always fails'),
            retriesExhausted: false,
          });
        },
      },
      until: until.maxSteps(100),
      maxIterations: 10,
      onError: () => 'retry',
    };

    const ctx = new ContextImpl();
    try {
      await executeLoop(loopStep, 'go', ctx, simpleExecuteStep);
      expect(true).toBe(false);
    } catch (e) {
      expect(isOrchidError(e)).toBe(true);
      expect(attempts).toBe(10); // capped by maxIterations
    }
  });

  it('uses verified predicate with feedback', async () => {
    let iteration = 0;
    const feedbacks: (string | undefined)[] = [];

    const loopStep: StepLoop<string, string> = {
      kind: 'loop',
      id: 'verify-loop',
      body: {
        kind: 'run',
        id: 'attempt',
        execute: async (input: string) => {
          iteration++;
          return iteration >= 3 ? 'correct' : 'wrong';
        },
      },
      until: until.verified(async (output) => {
        if (output === 'correct') return { pass: true };
        return { pass: false, feedback: 'Not correct yet' };
      }),
      prepareNext: (output, verdict) => {
        feedbacks.push(verdict.feedback);
        return verdict.feedback ?? 'continue';
      },
    };

    const ctx = new ContextImpl();
    const result = await executeLoop(loopStep, 'start', ctx, simpleExecuteStep);
    expect(result).toBe('correct');
    expect(iteration).toBe(3);
    expect(feedbacks[0]).toBe('Not correct yet');
  });
});
