import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { spawn } from '../../src/builders/spawn-builder';
import type { MemoryLayer } from '../../src/types/memory';

describe('spawn builder', () => {
  it('creates correct step shape', () => {
    const s = spawn({
      id: 'test-spawn',
      child: {
        kind: 'run',
        id: 'child',
        execute: async (i: string) => i,
      },
    });
    expect(s.kind).toBe('spawn');
    expect(s.id).toBe('test-spawn');
  });

  it('supports timeout option', () => {
    const s = spawn({
      id: 'timeout-spawn',
      child: {
        kind: 'run',
        id: 'child',
        execute: async (i: string) => i,
      },
      timeout: 5e3,
    });
    expect(s.timeout).toBe(5e3);
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
      }),
    ).toThrow('non-empty id');
  });

  it('throws on missing child', () => {
    type SpawnOpts = Parameters<typeof spawn>[0];
    // Cast via unknown to test runtime validation
    const badOpts = {
      id: 'test',
      child: undefined,
    } as unknown as SpawnOpts;
    expect(() => spawn(badOpts)).toThrow('child step');
  });

  it('supports optional memory field', () => {
    const layer = {
      id: 'test-layer',
      name: 'Test Layer',
      slot: 100,
      scope: 'thread',
      hooks: {},
    } satisfies MemoryLayer;

    const s = spawn({
      id: 'memory-spawn',
      child: {
        kind: 'run',
        id: 'child',
        execute: async (i: string) => i,
      },
      memory: [
        layer,
      ],
    });

    assert(s.memory !== undefined);
    expect(s.memory).toHaveLength(1);
    expect(s.memory[0].id).toBe('test-layer');
  });
});
