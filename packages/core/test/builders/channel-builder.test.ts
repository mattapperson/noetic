import { describe, it, expect } from 'bun:test';
import { channel } from '../../src/builders/channel-builder';
import { z } from 'zod';

describe('channel builder', () => {
  it('creates value channel', () => {
    const schema = z.string();
    const ch = channel('test', { schema, mode: 'value' });
    expect(ch.name).toBe('test');
    expect(ch.mode).toBe('value');
    expect(ch.schema).toBe(schema);
  });

  it('creates queue channel with capacity', () => {
    const ch = channel('q', { schema: z.number(), mode: 'queue', capacity: 100 });
    expect(ch.name).toBe('q');
    expect(ch.mode).toBe('queue');
    expect(ch.capacity).toBe(100);
  });

  it('creates topic channel', () => {
    const ch = channel('t', { schema: z.string(), mode: 'topic' });
    expect(ch.name).toBe('t');
    expect(ch.mode).toBe('topic');
  });

  it('creates external channel', () => {
    const ch = channel('ext', { schema: z.string(), mode: 'queue', external: true });
    expect((ch as any).external).toBe(true);
  });

  it('does not set external when not specified', () => {
    const ch = channel('int', { schema: z.string(), mode: 'queue' });
    expect((ch as any).external).toBeUndefined();
  });

  it('preserves schema reference', () => {
    const schema = z.object({ x: z.number() });
    const ch = channel('obj', { schema, mode: 'value' });
    expect(ch.schema).toBe(schema);
  });
});
