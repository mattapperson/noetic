import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { NoeticError } from '@noetic-tools/types';
import { isNoeticError, NoeticConfigError, NoeticErrorImpl } from '@noetic-tools/types';
import { callModel } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { wrapModelError } from '../../src/interpreter/model-error';

//#region Helper Functions

const LIVE = {
  aborted: false,
  abortReason: undefined,
};

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), {
    statusCode,
  });
}

function failingHarness(error: unknown): AgentHarness {
  return new AgentHarness({
    name: 'test',
    params: {},
    _testCallModel: async () => {
      throw error;
    },
  });
}

//#endregion

//#region Tests

describe('wrapModelError', () => {
  it('passes NoeticError and NoeticConfigError through untouched', () => {
    const noetic = new NoeticErrorImpl({
      kind: 'model_refused',
      stepId: 's',
      refusal: 'no',
    });
    const config = new NoeticConfigError({
      code: 'MISSING_API_KEY',
      message: 'Missing key.',
      hint: 'Set the key.',
    });
    expect(wrapModelError(noetic, 's', LIVE)).toBe(noetic);
    expect(wrapModelError(config, 's', LIVE)).toBe(config);
  });

  it('maps a failure on an aborted context to cancelled', () => {
    const wrapped = wrapModelError(new Error('socket closed'), 's', {
      aborted: true,
      abortReason: 'user stop',
    });
    assert(isNoeticError(wrapped));
    expect(wrapped.noeticError).toEqual({
      kind: 'cancelled',
      reason: 'user stop',
    });
  });

  it('maps a 429 to model_rate_limit', () => {
    const wrapped = wrapModelError(httpError('slow down', 429), 'gen', LIVE);
    assert(isNoeticError(wrapped));
    expect(wrapped.noeticError).toEqual({
      kind: 'model_rate_limit',
      stepId: 'gen',
    });
  });

  it('maps other failures to step_failed with the provider error as cause', () => {
    const cause = httpError('bad request', 400);
    const wrapped = wrapModelError(cause, 'gen', LIVE);
    assert(isNoeticError(wrapped));
    assert(wrapped.noeticError.kind === 'step_failed');
    expect(wrapped.noeticError.stepId).toBe('gen');
    expect(wrapped.noeticError.cause).toBe(cause);
  });

  it('wraps a thrown non-Error value', () => {
    const wrapped = wrapModelError('boom', 'gen', LIVE);
    assert(isNoeticError(wrapped));
    assert(wrapped.noeticError.kind === 'step_failed');
    expect(wrapped.noeticError.cause.message).toBe('boom');
  });
});

describe('callModel provider failures', () => {
  const cases: Array<
    [
      Error,
      NoeticError['kind'],
    ]
  > = [
    [
      httpError('slow down', 429),
      'model_rate_limit',
    ],
    [
      httpError('upstream exploded', 500),
      'step_failed',
    ],
  ];

  for (const [error, kind] of cases) {
    it(`reach the caller as ${kind}`, async () => {
      const harness = failingHarness(error);
      const ctx = harness.createContext();
      try {
        await harness.run(
          callModel({
            id: 'generate',
            model: 'm/x',
          }),
          'hi',
          ctx,
        );
        expect.unreachable();
      } catch (e) {
        assert(isNoeticError(e));
        expect(e.noeticError.kind).toBe(kind);
      }
      expect(ctx.tokens.input).toBe(0);
    });
  }
});

//#endregion
