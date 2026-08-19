import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { Step } from '@noetic-tools/types';
import { isNoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import { channel } from '../../src/builders/channel-builder';
import { schedule } from '../../src/builders/every';

const body: Step<unknown, void, void> = {
  kind: 'runCode',
  id: 'tick',
  execute: async (): Promise<void> => {},
};

describe('every builder', () => {
  it('constructs a StepSchedule with discriminator', () => {
    const s = schedule({
      id: 'tick-every',
      step: body,
      interval: 100,
    });
    expect(s.kind).toBe('schedule');
    expect(s.id).toBe('tick-every');
    expect(s.step).toBe(body);
    expect(s.interval).toBe(100);
  });

  it('default onError is continue', () => {
    const s = schedule({
      id: 'tick-default-onerror',
      step: body,
      interval: 50,
    });
    expect(s.onError).toBe('continue');
  });

  it('default jitter is 0', () => {
    const s = schedule({
      id: 'tick-default-jitter',
      step: body,
      interval: 50,
    });
    expect(s.jitter).toBe(0);
  });

  it('forwards optional fields', () => {
    const inbox = channel('wake', {
      schema: z.string(),
      mode: 'queue',
    });
    const s = schedule({
      id: 'tick-full',
      step: body,
      interval: 200,
      inbox,
      onError: 'fail',
      jitter: 25,
    });
    expect(s.inbox).toBe(inbox);
    expect(s.onError).toBe('fail');
    expect(s.jitter).toBe(25);
  });

  it('rejects empty id', () => {
    expect(() =>
      schedule({
        id: '',
        step: body,
        interval: 100,
      }),
    ).toThrow('non-empty id');
  });

  it('rejects whitespace-only id', () => {
    expect(() =>
      schedule({
        id: '   ',
        step: body,
        interval: 100,
      }),
    ).toThrow('non-empty id');
  });

  it('rejects missing body step', () => {
    let caught: unknown;
    try {
      schedule({
        id: 'tick-missing-body',
        // @ts-expect-error — intentionally passing invalid opts to test runtime validation
        step: undefined,
        interval: 100,
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
      schedule({
        id: 'tick-neg-ms',
        step: body,
        interval: -1,
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
      schedule({
        id: 'tick-nan-ms',
        step: body,
        interval: Number.NaN,
      });
    } catch (e) {
      caught = e;
    }
    assert(isNoeticConfigError(caught));
    expect(caught.code).toBe('INVALID_INTERVAL_MS');
  });

  it('accepts ms of 0', () => {
    const s = schedule({
      id: 'tick-zero-ms',
      step: body,
      interval: 0,
    });
    expect(s.interval).toBe(0);
  });

  it('rejects negative jitter', () => {
    let caught: unknown;
    try {
      schedule({
        id: 'tick-neg-jitter',
        step: body,
        interval: 100,
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
      schedule({
        id: 'tick-inf-jitter',
        step: body,
        interval: 100,
        jitter: Number.POSITIVE_INFINITY,
      });
    } catch (e) {
      caught = e;
    }
    assert(isNoeticConfigError(caught));
    expect(caught.code).toBe('INVALID_JITTER');
  });
});
