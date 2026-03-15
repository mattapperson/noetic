import { describe, it, expect } from 'bun:test';
import { fork } from '../../src/builders/control-flow-builders';
import type { Step, SettleResult } from '../../src/types/step';

describe('fork builder', () => {
  it('creates race mode fork', () => {
    const f = fork<string, string>({
      id: 'race-test',
      mode: 'race',
      paths: () => [
        { kind: 'run', id: 'a', execute: async (i: string) => i },
        { kind: 'run', id: 'b', execute: async (i: string) => i },
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
        { kind: 'run', id: 'a', execute: async (i: string) => i },
      ],
      merge: (results) => results.join(','),
    });
    expect(f.kind).toBe('fork');
    expect(f.mode).toBe('all');
    expect(f.merge).toBeFunction();
  });

  it('creates settle mode fork with merge', () => {
    const f = fork<string, string>({
      id: 'settle-test',
      mode: 'settle',
      paths: () => [
        { kind: 'run', id: 'a', execute: async (i: string) => i },
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

  it('paths is a function', () => {
    const f = fork<number, number>({
      id: 'fn-test',
      mode: 'race',
      paths: (input) => [
        { kind: 'run', id: `path-${input}`, execute: async (i: number) => i * 2 },
      ],
    });
    expect(f.paths).toBeFunction();
  });
});
