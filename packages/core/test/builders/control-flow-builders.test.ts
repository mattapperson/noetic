import { describe, expect, it } from 'bun:test';
import { branch, fork } from '../../src/builders/control-flow-builders';
import type { SettleResult } from '../../src/types/step';
import { makeMockContext } from '../_helpers';

describe('fork builder', () => {
  it('creates race mode fork', () => {
    const f = fork<string, string>({
      id: 'race-test',
      mode: 'race',
      paths: () => [
        {
          kind: 'run',
          id: 'a',
          execute: async (i: string) => i,
        },
        {
          kind: 'run',
          id: 'b',
          execute: async (i: string) => i,
        },
      ],
    });
    expect(f.kind).toBe('fork');
    expect(f.mode).toBe('race');
    expect(f.id).toBe('race-test');
  });

  it('creates all mode fork with merge', () => {
    const f = fork<string, string>({
      id: 'all-test',
      mode: 'all',
      paths: () => [
        {
          kind: 'run',
          id: 'a',
          execute: async (i: string) => i,
        },
      ],
      merge: (results) => results.join(','),
    });
    expect(f.kind).toBe('fork');
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

  it('creates settle mode fork with merge', () => {
    const f = fork<string, string>({
      id: 'settle-test',
      mode: 'settle',
      paths: () => [
        {
          kind: 'run',
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
    expect(f.kind).toBe('fork');
    expect(f.mode).toBe('settle');
  });

  it('supports concurrency option', () => {
    const f = fork<string, string>({
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
      fork<string, string>({
        id: '',
        mode: 'race',
        paths: () => [],
      }),
    ).toThrow('non-empty id');
  });

  it('throws when all mode lacks merge', () => {
    // Cast via unknown to intentionally bypass type safety and test runtime validation
    const badOpts = {
      id: 'test',
      mode: 'all',
      paths: () => [],
    } as unknown as Parameters<typeof fork<string, string>>[0];
    expect(() => fork<string, string>(badOpts)).toThrow('merge function');
  });

  it('throws when settle mode lacks merge', () => {
    // Cast via unknown to intentionally bypass type safety and test runtime validation
    const badOpts = {
      id: 'test',
      mode: 'settle',
      paths: () => [],
    } as unknown as Parameters<typeof fork<string, string>>[0];
    expect(() => fork<string, string>(badOpts)).toThrow('merge function');
  });

  it('paths is a function', () => {
    const f = fork<number, number>({
      id: 'fn-test',
      mode: 'race',
      paths: (input) => [
        {
          kind: 'run',
          id: `path-${input}`,
          execute: async (i: number) => i * 2,
        },
      ],
    });
    expect(f.paths).toBeFunction();
    const paths = f.paths(5, makeMockContext());
    expect(paths).toHaveLength(1);
    expect(paths[0].kind).toBe('run');
    expect(paths[0].id).toBe('path-5');
  });
});

describe('branch builder', () => {
  it('throws on empty id', () => {
    expect(() =>
      branch<string, string>({
        id: '',
        route: () => null,
      }),
    ).toThrow('non-empty id');
  });

  it('throws on missing route', () => {
    // Cast via unknown to intentionally bypass type safety and test runtime validation
    type RouteOpts = Parameters<typeof branch<string, string>>[0];
    const badOpts = {
      id: 'test',
      route: undefined,
    } as unknown as RouteOpts;
    expect(() => branch<string, string>(badOpts)).toThrow('route function');
  });
});
