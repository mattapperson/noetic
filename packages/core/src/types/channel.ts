import type { ZodType } from 'zod';

export interface Channel<T> {
  readonly name: string;
  readonly schema: ZodType<T>;
  readonly mode: 'value' | 'queue' | 'topic';
  readonly capacity?: number;
}

export interface ExternalChannel<T> extends Channel<T> {
  readonly external: true;
}

export interface ChannelHandle<T> {
  send(value: T): void;
  readonly closed: boolean;
  readonly channel: Channel<T>;
}
