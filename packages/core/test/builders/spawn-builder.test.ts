import { describe, it, expect } from 'bun:test';
import { spawn } from '../../src/builders/spawn-builder';

describe('spawn builder', () => {
  it('creates correct step shape', () => {
    const s = spawn({
      id: 'test-spawn',
      child: { kind: 'run', id: 'child', execute: async (i: string) => i },
      contextIn: { strategy: 'fresh' },
      contextOut: { strategy: 'full' },
    });
    expect(s.kind).toBe('spawn');
    expect(s.id).toBe('test-spawn');
    expect(s.contextIn.strategy).toBe('fresh');
    expect(s.contextOut.strategy).toBe('full');
  });

  it('supports timeout option', () => {
    const s = spawn({
      id: 'timeout-spawn',
      child: { kind: 'run', id: 'child', execute: async (i: string) => i },
      contextIn: { strategy: 'inherit' },
      contextOut: { strategy: 'full' },
      timeout: 5000,
    });
    expect(s.timeout).toBe(5000);
  });
});
