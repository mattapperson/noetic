import { describe, expect, it } from 'bun:test';
import { spawn } from '../../src/builders/spawn-builder';

describe('spawn builder', () => {
  it('creates correct step shape', () => {
    const s = spawn({
      id: 'test-spawn',
      child: {
        kind: 'run',
        id: 'child',
        execute: async (i: string) => i,
      },
      contextIn: {
        strategy: 'fresh',
      },
      contextOut: {
        strategy: 'full',
      },
    });
    expect(s.kind).toBe('spawn');
    expect(s.id).toBe('test-spawn');
    expect(s.contextIn.strategy).toBe('fresh');
    expect(s.contextOut.strategy).toBe('full');
  });

  it('supports timeout option', () => {
    const s = spawn({
      id: 'timeout-spawn',
      child: {
        kind: 'run',
        id: 'child',
        execute: async (i: string) => i,
      },
      contextIn: {
        strategy: 'inherit',
      },
      contextOut: {
        strategy: 'full',
      },
      timeout: 5_000,
    });
    expect(s.timeout).toBe(5_000);
  });

  it('throws on empty id', () => {
    expect(() =>
      spawn({
        id: '',
        child: {
          kind: 'run',
          id: 'child',
          execute: async (i: string) => i,
        },
        contextIn: {
          strategy: 'fresh',
        },
        contextOut: {
          strategy: 'full',
        },
      }),
    ).toThrow('non-empty id');
  });

  it('throws on whitespace-only id', () => {
    expect(() =>
      spawn({
        id: '  ',
        child: {
          kind: 'run',
          id: 'child',
          execute: async (i: string) => i,
        },
        contextIn: {
          strategy: 'fresh',
        },
        contextOut: {
          strategy: 'full',
        },
      }),
    ).toThrow('non-empty id');
  });

  it('throws on missing child', () => {
    // Cast via unknown to test runtime validation without bypassing with any
    type SpawnOpts = Parameters<typeof spawn>[0];
    const badOpts = {
      id: 'test',
      child: undefined,
      contextIn: {
        strategy: 'fresh' as const,
      },
      contextOut: {
        strategy: 'full' as const,
      },
    } as unknown as SpawnOpts;
    expect(() => spawn(badOpts)).toThrow('child step');
  });
});
