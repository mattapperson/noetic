import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { loop } from '../../src/builders/loop-builder';
import { until } from '../../src/until/predicates';

describe('loop builder', () => {
  const body = {
    kind: 'run' as const,
    id: 'child',
    execute: async (i: string) => i,
  };

  it('creates correct step shape', () => {
    const s = loop({
      id: 'test-loop',
      body,
      until: until.maxSteps(3),
    });
    expect(s.kind).toBe('loop');
    expect(s.id).toBe('test-loop');
    expect(s.body).toBe(body);
  });

  it('forwards all optional fields', () => {
    const prepareNext = (output: string) => output;
    const onError = () => 'retry' as const;
    const s = loop({
      id: 'full-loop',
      body,
      until: until.maxSteps(5),
      maxIterations: 50,
      maxHistorySize: 10,
      parkTimeout: 3e3,
      prepareNext,
      onError,
    });
    expect(s.maxIterations).toBe(50);
    expect(s.maxHistorySize).toBe(10);
    expect(s.parkTimeout).toBe(3e3);
    assert(s.prepareNext !== undefined);
    expect(s.prepareNext).toBe(prepareNext);
    assert(s.onError !== undefined);
    expect(s.onError).toBe(onError);
  });

  it('throws on empty id', () => {
    expect(() =>
      loop({
        id: '',
        body,
        until: until.maxSteps(1),
      }),
    ).toThrow('non-empty id');
  });

  it('throws on whitespace-only id', () => {
    expect(() =>
      loop({
        id: '  ',
        body,
        until: until.maxSteps(1),
      }),
    ).toThrow('non-empty id');
  });

  it('throws on missing body', () => {
    expect(() =>
      loop({
        id: 'test',
        body: undefined,
        until: until.maxSteps(1),
      } as never),
    ).toThrow('body step');
  });

  it('throws on missing until', () => {
    expect(() =>
      loop({
        id: 'test',
        body,
        until: undefined,
      } as never),
    ).toThrow('until predicate');
  });
});
