import type { ZodType } from 'zod';
import type { Channel, ExternalChannel } from '../types/channel';

export function channel<T>(name: string, opts: {
  schema: ZodType<T>;
  mode: 'value' | 'queue' | 'topic';
  capacity?: number;
  external?: boolean;
}): Channel<T> {
  const ch: any = { name, schema: opts.schema, mode: opts.mode, capacity: opts.capacity };
  if (opts.external) ch.external = true;
  return ch;
}
