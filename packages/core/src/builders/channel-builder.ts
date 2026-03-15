import type { ZodType } from 'zod';
import type { Channel, ExternalChannel } from '../types/channel';

export function channel<T>(name: string, opts: {
  schema: ZodType<T>;
  mode: 'value' | 'queue' | 'topic';
  capacity?: number;
  external: true;
}): ExternalChannel<T>;

export function channel<T>(name: string, opts: {
  schema: ZodType<T>;
  mode: 'value' | 'queue' | 'topic';
  capacity?: number;
  external?: false;
}): Channel<T>;

export function channel<T>(name: string, opts: {
  schema: ZodType<T>;
  mode: 'value' | 'queue' | 'topic';
  capacity?: number;
  external?: boolean;
}): Channel<T> | ExternalChannel<T> {
  const ch: Channel<T> = { name, schema: opts.schema, mode: opts.mode, capacity: opts.capacity };
  if (opts.external) {
    return { ...ch, external: true as const };
  }
  return ch;
}
