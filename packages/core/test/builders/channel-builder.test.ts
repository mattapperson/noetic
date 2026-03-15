import { describe, it, expect } from 'bun:test';
import { channel } from '../../src/builders/channel-builder';
import { z } from 'zod';

describe('channel builder', () => {
  it('creates value channel', () => {
    const ch = channel('test', { schema: z.string(), mode: 'value' });
    expect(ch.name).toBe('test');
    expect(ch.mode).toBe('value');
  });

  it('creates queue channel with capacity', () => {
    const ch = channel('q', { schema: z.number(), mode: 'queue', capacity: 100 });
    expect(ch.capacity).toBe(100);
  });

  it('creates topic channel', () => {
    const ch = channel('t', { schema: z.string(), mode: 'topic' });
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
