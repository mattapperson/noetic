import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextLayer } from '@noetic-tools/context';
import { spawn } from '../../src/builders/spawn-builder';

describe('spawn builder', () => {
  it('creates correct step shape', () => {
    const s = spawn({
      id: 'test-spawn',
      child: {
        kind: 'runCode',
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
        kind: 'runCode',
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
          kind: 'runCode',
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
          kind: 'runCode',
          id: 'child',
          execute: async (i: string) => i,
        },
      }),
    ).toThrow('non-empty id');
  });

  it('throws on missing child', () => {
    expect(() =>
      spawn({
        id: 'test',
        // @ts-expect-error — intentionally passing invalid opts to test runtime validation
        child: undefined,
      }),
    ).toThrow('child step');
  });

  it('supports optional memory field', () => {
    const layer = {
      id: 'test-layer',
      name: 'Test Layer',
      slot: 100,
      scope: 'thread',
      hooks: {},
    } satisfies ContextLayer;

    const s = spawn({
      id: 'memory-spawn',
      child: {
        kind: 'runCode',
        id: 'child',
        execute: async (i: string) => i,
      },
      context: [
        layer,
      ],
    });

    assert(s.context !== undefined);
    assert(Array.isArray(s.context));
    expect(s.context).toHaveLength(1);
    expect(s.context[0].id).toBe('test-layer');
  });
});
