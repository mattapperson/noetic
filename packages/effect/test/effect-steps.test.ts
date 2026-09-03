import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import { effectStep } from '@noetic-tools/core';
import type { Context, EffectStepRuntime, NoeticError, StepEffect } from '@noetic-tools/types';
import { frameworkCast, isNoeticError, NoeticErrorImpl } from '@noetic-tools/types';
import { Effect } from 'effect';
import { z } from 'zod';
import { ContextImpl, executeEffect } from '../../core/src/internal-test';
import { makeMockHarness } from '../../core/test/_helpers';
import * as Adapter from '../src/index';

const makeEffectRuntime = Adapter.effectStep;

/** Build a minimal live ContextImpl (real abort signal + item log). */
function makeLiveCtx(): ContextImpl {
  return new ContextImpl({
    harness: makeMockHarness(),
  });
}

describe('executeEffect', () => {
  it('runs a program and returns its output', async () => {
    const ctx = makeLiveCtx();
    const runtime = makeEffectRuntime<number, number, never>({
      program: (input: number) => Effect.sync(() => input * 2),
      stepId: 'double',
    });
    const s: StepEffect<ContextData, number, number> = {
      kind: 'effect',
      id: 'double',
      runtime,
    };
    const result = await executeEffect(s, 21, ctx);
    expect(result).toBe(42);
  });

  it('maps typed failures through mapError', async () => {
    const ctx = makeLiveCtx();
    const runtime = makeEffectRuntime<
      number,
      number,
      {
        _tag: 'Boom';
        code: number;
      }
    >({
      program: Effect.fail({
        _tag: 'Boom',
        code: 7,
      }),
      stepId: 'mapped',
      mapError: (e): NoeticError => ({
        kind: 'step_failed',
        stepId: 'mapped',
        cause: new Error(`boom ${e.code}`),
        retriesExhausted: false,
      }),
    });
    const s: StepEffect<ContextData, number, number> = {
      kind: 'effect',
      id: 'mapped',
      runtime,
    };
    try {
      await executeEffect(s, 1, ctx);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('step_failed');
      expect(e.message).toContain('boom 7');
    }
  });

  it('without mapError, typed failures fall back to step_failed', async () => {
    const ctx = makeLiveCtx();
    const runtime = makeEffectRuntime<number, never, string>({
      program: Effect.fail('plain string failure'),
      stepId: 'fallback',
    });
    const s: StepEffect<ContextData, number, never> = {
      kind: 'effect',
      id: 'fallback',
      runtime,
    };
    try {
      await executeEffect(s, 1, ctx);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('step_failed');
      expect(e.message).toContain('plain string failure');
    }
  });

  it('defects surface as step_failed around the defect', async () => {
    const ctx = makeLiveCtx();
    const runtime = makeEffectRuntime<number, never, never>({
      program: Effect.die(new Error('defect-boom')),
      stepId: 'defecty',
    });
    const s: StepEffect<ContextData, number, never> = {
      kind: 'effect',
      id: 'defecty',
      runtime,
    };
    try {
      await executeEffect(s, 1, ctx);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('step_failed');
      expect(e.message).toContain('defect-boom');
    }
  });

  it('aborting the context interrupts the program as cancelled', async () => {
    const ctx = makeLiveCtx();
    let sawInterrupt = false;
    const runtime = makeEffectRuntime<number, string, never>({
      program: Effect.sleep(5_000).pipe(
        Effect.as('never'),
        Effect.onInterrupt(() => {
          sawInterrupt = true;
          return Effect.void;
        }),
      ),
      stepId: 'sleepy',
    });
    const s: StepEffect<ContextData, number, string> = {
      kind: 'effect',
      id: 'sleepy',
      runtime,
    };
    const runPromise = executeEffect(s, 1, ctx);
    // Abort shortly after dispatch so the fiber is mid-sleep.
    setTimeout(() => ctx.abort('stop sleeping'), 30);
    try {
      await runPromise;
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('cancelled');
    }
    expect(sawInterrupt).toBe(true);
  });

  it('retry policy re-runs a failing program until it succeeds', async () => {
    const ctx = makeLiveCtx();
    let attempts = 0;
    const runtime = makeEffectRuntime<number, number, unknown>({
      program: Effect.sync(() => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(`attempt ${attempts} failed`);
        }
        return attempts;
      }),
      stepId: 'retried',
    });
    const s: StepEffect<ContextData, number, number> = {
      kind: 'effect',
      id: 'retried',
      runtime,
      retry: {
        maxAttempts: 3,
        backoff: 'fixed',
        initialDelay: 1,
      },
    };
    const result = await executeEffect(s, 0, ctx);
    expect(result).toBe(3);
    expect(attempts).toBe(3);
  });

  it('cancelled rejections bypass retry (cancellation is not retriable)', async () => {
    const ctx = makeLiveCtx();
    let attempts = 0;
    const runtime = makeEffectRuntime<number, never, never>({
      program: Effect.sync(() => {
        attempts += 1;
        throw new NoeticErrorImpl({
          kind: 'cancelled',
          reason: 'user abort',
        });
      }),
      stepId: 'no-retry',
    });
    const s: StepEffect<ContextData, number, never> = {
      kind: 'effect',
      id: 'no-retry',
      runtime,
      retry: {
        maxAttempts: 3,
        backoff: 'fixed',
        initialDelay: 1,
      },
    };
    try {
      await executeEffect(s, 0, ctx);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('cancelled');
    }
    expect(attempts).toBe(1);
  });

  it('validates input and output schemas around the program', async () => {
    const ctx = makeLiveCtx();
    const runtime = makeEffectRuntime<
      number,
      {
        doubled: number;
      },
      never
    >({
      program: (input: number) =>
        Effect.sync(() => ({
          doubled: input * 2,
        })),
      stepId: 'validated',
    });
    const s: StepEffect<
      ContextData,
      number,
      {
        doubled: number;
      }
    > = {
      kind: 'effect',
      id: 'validated',
      runtime,
      inputSchema: z.number(),
      output: z.object({
        doubled: z.number(),
      }),
    };
    const result = await executeEffect(s, 5, ctx);
    expect(result).toEqual({
      doubled: 10,
    });
  });

  it('rejects a mis-shaped runtime with INVALID_EFFECT_RUNTIME', async () => {
    const ctx = makeLiveCtx();
    const s = frameworkCast<StepEffect<ContextData, number, number>>({
      kind: 'effect',
      id: 'bad-runtime',
      runtime: {
        nope: true,
      },
    });
    try {
      await executeEffect(s, 1, ctx);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(!isNoeticError(e));
      assert(e instanceof Error);
      expect(e.name).toBe('NoeticConfigError');
      expect(
        frameworkCast<
          Error & {
            code: string;
          }
        >(e).code,
      ).toBe('INVALID_EFFECT_RUNTIME');
    }
  });

  it('works with a hand-rolled runtime (no effect dependency needed)', async () => {
    const ctx = makeLiveCtx();
    const runtime: EffectStepRuntime<ContextData, string, string> = {
      run: (input, _ctx, signal) =>
        signal.aborted
          ? Promise.reject(
              new NoeticErrorImpl({
                kind: 'cancelled',
                reason: 'already aborted',
              }),
            )
          : Promise.resolve(`${input}!`),
    };
    const s: StepEffect<ContextData, string, string> = {
      kind: 'effect',
      id: 'handrolled',
      runtime,
    };
    const result = await executeEffect(s, 'hi', ctx);
    expect(result).toBe('hi!');
  });
});

describe('effectStep builder + registry', () => {
  it('registers the built step', () => {
    const runtime = makeEffectRuntime<number, number, never>({
      program: Effect.sync(() => 1),
      stepId: 'reg',
    });
    const built = effectStep<ContextData, number, number>({
      id: 'registry-check',
      runtime: () => runtime,
    });
    expect(built.kind).toBe('effect');
  });

  it('throws EMPTY_STEP_ID for a blank id', () => {
    const runtime = makeEffectRuntime<number, number, never>({
      program: Effect.sync(() => 1),
      stepId: 'x',
    });
    expect(() =>
      effectStep<ContextData, number, number>({
        id: '',
        runtime,
      }),
    ).toThrow(/non-empty id/);
  });

  it('throws MISSING_EFFECT_RUNTIME when runtime is missing', () => {
    expect(() =>
      effectStep<ContextData, number, number>(
        frameworkCast({
          id: 'no-runtime',
        }),
      ),
    ).toThrow(/requires a runtime/);
  });
});

describe('EffectStepRuntime + Effect Schema interop', () => {
  it('an Effect Schema (Standard Schema v1) validates as a step output', async () => {
    const { Schema } = await import('effect');
    const ctx = makeLiveCtx();
    const Out = Schema.Struct({
      ok: Schema.Boolean,
    });
    const std = Schema.toStandardSchemaV1(Out);
    const runtime = makeEffectRuntime<
      number,
      {
        ok: boolean;
      },
      never
    >({
      program: (input: number) =>
        Effect.sync(() => ({
          ok: input > 0,
        })),
      stepId: 'schema-out',
    });
    const s: StepEffect<
      ContextData,
      number,
      {
        ok: boolean;
      }
    > = {
      kind: 'effect',
      id: 'schema-out',
      runtime,
      output: std,
    };
    const result = await executeEffect(s, 2, ctx);
    expect(result).toEqual({
      ok: true,
    });
  });

  it('a Context instance passes through to the runtime', async () => {
    const ctx = makeLiveCtx();
    const seen: Context[] = [];
    const runtime: EffectStepRuntime<ContextData, void, void> = {
      run: (_input, c) => {
        seen.push(c);
        return Promise.resolve();
      },
    };
    const s: StepEffect<ContextData, void, void> = {
      kind: 'effect',
      id: 'ctx-seen',
      runtime,
    };
    await executeEffect(s, undefined, ctx);
    expect(seen[0]).toBe(ctx);
  });
});
