import { describe, expect, it } from 'bun:test';
import type { ContextData } from '@noetic-tools/context';
import type { SettleResult } from '@noetic-tools/types';
import { conditional, inParallel } from '../../src/builders/control-flow-builders';
import { makeMockContext } from '../_helpers';

describe('inParallel builder', () => {
  it('creates race mode inParallel', () => {
    const f = inParallel<ContextData, string, string>({
      id: 'race-test',
      mode: 'race',
      paths: () => [
        {
          kind: 'runCode',
          id: 'a',
          execute: async (i: string) => i,
        },
        {
          kind: 'runCode',
          id: 'b',
          execute: async (i: string) => i,
        },
      ],
    });
    expect(f.kind).toBe('inParallel');
    expect(f.mode).toBe('race');
    expect(f.id).toBe('race-test');
  });

  it('creates all mode inParallel with merge', () => {
    const f = inParallel<ContextData, string, string>({
      id: 'all-test',
      mode: 'all',
      paths: () => [
        {
          kind: 'runCode',
          id: 'a',
          execute: async (i: string) => i,
        },
      ],
      merge: (results) => results.join(','),
    });
    expect(f.kind).toBe('inParallel');
    expect(f.mode).toBe('all');
    expect(f.merge).toBeFunction();
    const merged = f.merge(
      [
        'a',
        'b',
        'c',
      ],
      makeMockContext(),
    );
    expect(merged).toBe('a,b,c');
  });

  it('creates settle mode inParallel with merge', () => {
    const f = inParallel<ContextData, string, string>({
      id: 'settle-test',
      mode: 'settle',
      paths: () => [
        {
          kind: 'runCode',
          id: 'a',
          execute: async (i: string) => i,
        },
      ],
      merge: (results: SettleResult<string>[]) =>
        results
          .filter((r) => r.status === 'fulfilled')
          .map((r) => r.value!)
          .join(','),
    });
    expect(f.kind).toBe('inParallel');
    expect(f.mode).toBe('settle');
  });

  it('supports concurrency option', () => {
    const f = inParallel<ContextData, string, string>({
      id: 'conc-test',
      mode: 'all',
      paths: () => [],
      merge: (r) => r.join(''),
      concurrency: 2,
    });
    expect(f.concurrency).toBe(2);
  });

  it('throws on empty id', () => {
    expect(() =>
      inParallel<ContextData, string, string>({
        id: '',
        mode: 'race',
        paths: () => [],
      }),
    ).toThrow('non-empty id');
  });

  it('throws when all mode lacks merge', () => {
    expect(() =>
      // @ts-expect-error — a merge-less inParallel matches no overload, so the
      // mismatch surfaces on the call; runtime validation is what this test is
      // asserting.
      inParallel<ContextData, string, string>({
        id: 'test',
        mode: 'all',
        paths: () => [],
      }),
    ).toThrow('merge function');
  });

  it('throws when settle mode lacks merge', () => {
    expect(() =>
      // @ts-expect-error — intentionally passing invalid opts to test runtime validation
      inParallel<ContextData, string, string>({
        id: 'test',
        mode: 'settle',
        paths: () => [],
      }),
    ).toThrow('merge function');
  });

  it('paths is a function', () => {
    const f = inParallel<ContextData, number, number>({
      id: 'fn-test',
      mode: 'race',
      paths: (input) => [
        {
          kind: 'runCode',
          id: `path-${input}`,
          execute: async (i: number) => i * 2,
        },
      ],
    });
    expect(f.paths).toBeFunction();
    const paths = f.paths(5, makeMockContext());
    expect(paths).toHaveLength(1);
    expect(paths[0].kind).toBe('runCode');
    expect(paths[0].id).toBe('path-5');
  });
});

describe('conditional builder', () => {
  it('throws on empty id', () => {
    expect(() =>
      conditional<ContextData, string, string>({
        id: '',
        route: () => null,
      }),
    ).toThrow('non-empty id');
  });

  it('throws on missing route', () => {
    expect(() =>
      conditional<ContextData, string, string>({
        id: 'test',
        // @ts-expect-error — intentionally passing invalid opts to test runtime validation
        route: undefined,
      }),
    ).toThrow('route function');
  });
});
