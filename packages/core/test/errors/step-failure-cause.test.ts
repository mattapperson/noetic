import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import { failureCause, isNoeticError } from '@noetic-tools/types';
import { runCode } from '../../src/builders/step-builders';
import { execute } from '../../src/interpreter/execute';
import { ContextImpl } from '../../src/runtime/context-impl';
import { makeMockHarness } from '../_helpers';

class TypedFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'TypedFailure';
  }
}

function makeCtx(): ContextImpl {
  return new ContextImpl({
    harness: makeMockHarness(),
  });
}

describe('a code step’s thrown error reaches the caller (#140)', () => {
  it('attaches the thrown error as the step_failed NoeticError’s Error.cause', async () => {
    const original = new TypedFailure('http_500');
    const inner = runCode<ContextData, string, string>({
      id: 'inner',
      execute: async () => {
        throw original;
      },
    });
    const ctx = makeCtx();
    const caught = await execute(inner, 'x', ctx).catch((e: unknown) => e);
    assert(isNoeticError(caught));
    expect(caught.noeticError.kind).toBe('step_failed');
    expect(caught.cause).toBe(original);
    expect(caught.cause instanceof TypedFailure).toBe(true);
    expect(ctx.stepCount).toBeGreaterThan(0);
  });

  it('failureCause finds the typed error through nested code steps', async () => {
    const original = new TypedFailure('budget');
    const inner = runCode<ContextData, string, string>({
      id: 'inner',
      execute: async () => {
        throw original;
      },
    });
    const outer = runCode<ContextData, string, string>({
      id: 'outer',
      execute: async (input, ctx) => execute(inner, input, ctx),
    });
    const caught = await execute(outer, 'x', makeCtx()).catch((e: unknown) => e);
    assert(isNoeticError(caught));
    expect(caught.noeticError.kind).toBe('step_failed');
    const cause = failureCause(caught);
    assert(cause instanceof TypedFailure);
    expect(cause.code).toBe('budget');
  });

  it('keeps a thrown non-Error value as the wrapper error’s cause', async () => {
    const thrown = {
      status: 503,
    };
    const step = runCode<ContextData, string, string>({
      id: 'throws-object',
      execute: async () => {
        throw thrown;
      },
    });
    const caught = await execute(step, 'x', makeCtx()).catch((e: unknown) => e);
    assert(isNoeticError(caught));
    const wrapper = failureCause(caught);
    assert(wrapper instanceof Error);
    expect(wrapper.cause).toBe(thrown);
  });

  it('keeps the last attempt’s error as the cause after retries are exhausted', async () => {
    let attempts = 0;
    const step = runCode<ContextData, string, string>({
      id: 'retried',
      retry: {
        maxAttempts: 2,
        backoff: 'fixed',
        initialDelay: 0,
      },
      execute: async () => {
        attempts++;
        throw new TypedFailure(`attempt-${attempts}`);
      },
    });
    const caught = await execute(step, 'x', makeCtx()).catch((e: unknown) => e);
    assert(isNoeticError(caught));
    assert(caught.noeticError.kind === 'step_failed');
    expect(caught.noeticError.retriesExhausted).toBe(true);
    const cause = failureCause(caught);
    assert(cause instanceof TypedFailure);
    expect(cause.code).toBe('attempt-2');
  });
});
