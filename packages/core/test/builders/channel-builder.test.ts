import { describe, expect, it } from 'bun:test';
import type { Channel, ExternalChannel } from '@noetic-tools/types';
import { z } from 'zod';
import { channel } from '../../src/builders/channel-builder';

describe('channel builder', () => {
  it('creates value channel', () => {
    const schema = z.string();
    const ch = channel('test', {
      schema,
      mode: 'value',
    });
    expect(ch.name).toBe('test');
    expect(ch.mode).toBe('value');
    expect(ch.schema).toBe(schema);
  });

  it('creates queue channel with capacity', () => {
    const ch = channel('q', {
      schema: z.number(),
      mode: 'queue',
      capacity: 100,
    });
    expect(ch.name).toBe('q');
    expect(ch.mode).toBe('queue');
    expect(ch.capacity).toBe(100);
  });

  it('creates topic channel', () => {
    const ch = channel('t', {
      schema: z.string(),
      mode: 'topic',
    });
    expect(ch.name).toBe('t');
    expect(ch.mode).toBe('topic');
  });

  it('creates external channel', () => {
    const ch = channel('ext', {
      schema: z.string(),
      mode: 'queue',
      external: true,
    });
    // TypeScript narrows ch to ExternalChannel<string> when external: true
    expect(ch.external).toBe(true);
  });

  it('does not set external when not specified', () => {
    const ch = channel('int', {
      schema: z.string(),
      mode: 'queue',
    });
    // Channel<T> does not have an external property
    expect('external' in ch).toBe(false);
  });

  it('preserves schema reference', () => {
    const schema = z.object({
      x: z.number(),
    });
    const ch = channel('obj', {
      schema,
      mode: 'value',
    });
    expect(ch.schema).toBe(schema);
  });
  it('accepts a boolean external flag decided at run time', () => {
    const makeChannel = (external: boolean): Channel<string> | ExternalChannel<string> =>
      channel('dyn', {
        schema: z.string(),
        mode: 'queue',
        external,
      });
    const ext = makeChannel(true);
    const internal = makeChannel(false);
    expect('external' in ext && ext.external).toBe(true);
    expect('external' in internal).toBe(false);
  });

  it('narrows the return type for literal external flags', () => {
    const ext: ExternalChannel<string> = channel('lit-ext', {
      schema: z.string(),
      mode: 'queue',
      external: true,
    });
    const internal: Channel<string> = channel('lit-int', {
      schema: z.string(),
      mode: 'queue',
      external: false,
    });
    const flag: boolean = Math.random() > 2;
    // @ts-expect-error a non-literal flag cannot narrow to ExternalChannel
    const widened: ExternalChannel<string> = channel('wide', {
      schema: z.string(),
      mode: 'queue',
      external: flag,
    });
    expect(ext.external).toBe(true);
    expect(internal.name).toBe('lit-int');
    expect(widened.name).toBe('wide');
  });
});
