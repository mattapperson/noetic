import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { channel } from '../../src/builders/channel-builder';
import { every } from '../../src/builders/every';
import { isNoeticConfigError } from '../../src/errors/noetic-config-error';
import type { Step } from '../../src/types/step';

const body: Step<unknown, void, void> = {
  kind: 'run',
  id: 'tick',
  execute: async (): Promise<void> => {},
};

describe('every builder', () => {
  it('constructs a StepEvery with discriminator', () => {
    const s = every({
      id: 'tick-every',
      step: body,
      ms: 100,
    });
    expect(s.kind).toBe('every');
    expect(s.id).toBe('tick-every');
    expect(s.step).toBe(body);
    expect(s.ms).toBe(100);
  });

  it('default onError is continue', () => {
    const s = every({
      id: 'tick-default-onerror',
      step: body,
      ms: 50,
    });
    expect(s.onError).toBe('continue');
  });

  it('default jitter is 0', () => {
    const s = every({
      id: 'tick-default-jitter',
      step: body,
      ms: 50,
    });
    expect(s.jitter).toBe(0);
  });

  it('forwards optional fields', () => {
    const wakeOn = channel('wake', {
      schema: z.string(),
      mode: 'queue',
    });
    const s = every({
      id: 'tick-full',
      step: body,
      ms: 200,
      wakeOn,
      onError: 'fail',
      jitter: 25,
    });
    expect(s.wakeOn).toBe(wakeOn);
    expect(s.onError).toBe('fail');
    expect(s.jitter).toBe(25);
  });

  it('rejects empty id', () => {
    expect(() =>
      every({
        id: '',
        step: body,
        ms: 100,
      }),
    ).toThrow('non-empty id');
  });

  it('rejects whitespace-only id', () => {
    expect(() =>
      every({
        id: '   ',
        step: body,
        ms: 100,
      }),
    ).toThrow('non-empty id');
  });

  it('rejects missing body step', () => {
    let caught: unknown;
    try {
      every({
        id: 'tick-missing-body',
        // @ts-expect-error — intentionally passing invalid opts to test runtime validation
        step: undefined,
        ms: 100,
      });
    } catch (e) {
      caught = e;
    }
    assert(isNoeticConfigError(caught));
    expect(caught.code).toBe('MISSING_BODY_STEP');
  });

  it('rejects negative ms', () => {
    let caught: unknown;
    try {
      every({
        id: 'tick-neg-ms',
        step: body,
        ms: -1,
      });
    } catch (e) {
      caught = e;
    }
    assert(isNoeticConfigError(caught));
    expect(caught.code).toBe('INVALID_INTERVAL_MS');
  });

  it('rejects non-finite ms (NaN)', () => {
    let caught: unknown;
    try {
      every({
        id: 'tick-nan-ms',
        step: body,
        ms: Number.NaN,
      });
    } catch (e) {
      caught = e;
    }
    assert(isNoeticConfigError(caught));
    expect(caught.code).toBe('INVALID_INTERVAL_MS');
  });

  it('accepts ms of 0', () => {
    const s = every({
      id: 'tick-zero-ms',
      step: body,
      ms: 0,
    });
    expect(s.ms).toBe(0);
  });

  it('rejects negative jitter', () => {
    let caught: unknown;
    try {
      every({
        id: 'tick-neg-jitter',
        step: body,
        ms: 100,
        jitter: -5,
      });
    } catch (e) {
      caught = e;
    }
    assert(isNoeticConfigError(caught));
    expect(caught.code).toBe('INVALID_JITTER');
  });

  it('rejects non-finite jitter', () => {
    let caught: unknown;
    try {
      every({
        id: 'tick-inf-jitter',
        step: body,
        ms: 100,
        jitter: Number.POSITIVE_INFINITY,
      });
    } catch (e) {
      caught = e;
    }
    assert(isNoeticConfigError(caught));
    expect(caught.code).toBe('INVALID_JITTER');
  });
});
