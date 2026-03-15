import { OrchidErrorImpl } from '../errors/orchid-error';
import type { Channel, ChannelHandle, ExternalChannel } from '../types/channel';

function isExternalChannel<T>(ch: Channel<T>): ch is ExternalChannel<T> {
  // SAFETY: Channel<T> does not declare `external`. The `in` check confirms it
  // exists at runtime before we access it, narrowing to ExternalChannel<T>.
  return 'external' in ch && (ch as ExternalChannel<T>).external === true;
}

const MAX_TOPIC_TIMEOUT = 300_000; // 5 minutes

interface ChannelState<T> {
  mode: 'value' | 'queue' | 'topic';
  // value mode
  currentValue?: T;
  hasValue: boolean;
  valueWaiters: Array<{
    resolve: (v: T) => void;
    reject: (e: Error) => void;
  }>;
  // queue mode
  queue: T[];
  capacity: number;
  queueWaiters: Array<{
    resolve: (v: T) => void;
    reject: (e: Error) => void;
  }>;
  // topic mode
  topicSubscribers: Set<(value: T) => void>;
}

export class ChannelStore {
  private channels = new Map<string, ChannelState<unknown>>();
  private closedExecutions = new Set<string>();

  private getOrCreate<T>(channel: Channel<T>): ChannelState<T> {
    let state = this.channels.get(channel.name) as ChannelState<T> | undefined;
    if (!state) {
      state = {
        mode: channel.mode,
        hasValue: false,
        valueWaiters: [],
        queue: [],
        capacity: channel.capacity ?? 1_000,
        queueWaiters: [],
        topicSubscribers: new Set(),
      };
      this.channels.set(channel.name, state as ChannelState<unknown>);
    }
    return state;
  }

  send<T>(channel: Channel<T>, value: T): void {
    const state = this.getOrCreate(channel);

    switch (state.mode) {
      case 'value':
        state.currentValue = value;
        state.hasValue = true;
        if (state.valueWaiters.length > 0) {
          state.valueWaiters.shift()!.resolve(value);
        }
        break;
      case 'queue':
        if (state.queueWaiters.length > 0) {
          state.queueWaiters.shift()!.resolve(value);
        } else if (state.queue.length < state.capacity) {
          state.queue.push(value);
        } else {
          // At capacity
          console.warn(
            `[orchid] Channel '${channel.name}': queue at capacity (${state.capacity}), dropping message.`,
          );
          if (isExternalChannel(channel)) {
            state.queue.shift();
            state.queue.push(value);
          }
          // For internal, drop the new value
        }
        break;
      case 'topic':
        for (const sub of state.topicSubscribers) {
          sub(value);
        }
        break;
    }
  }

  async recv<T>(channel: Channel<T>, timeout = 30_000): Promise<T> {
    const state = this.getOrCreate(channel);

    switch (state.mode) {
      case 'value':
        if (state.hasValue) {
          return state.currentValue as T;
        }
        return this.waitWithTimeout(state.valueWaiters, channel.name, timeout);

      case 'queue':
        if (state.queue.length > 0) {
          return state.queue.shift()!;
        }
        return this.waitWithTimeout(state.queueWaiters, channel.name, timeout);

      case 'topic': {
        // Clamp timeout to prevent indefinite subscriber leaks
        let effectiveTimeout = timeout;
        if (effectiveTimeout <= 0) {
          console.warn(
            `[orchid] Channel '${channel.name}': topic recv with non-positive timeout, clamping to ${MAX_TOPIC_TIMEOUT}ms`,
          );
          effectiveTimeout = MAX_TOPIC_TIMEOUT;
        }

        return new Promise<T>((resolve, reject) => {
          const timer = setTimeout(() => {
            state.topicSubscribers.delete(handler);
            reject(
              new OrchidErrorImpl({
                kind: 'channel_timeout',
                channelName: channel.name,
                timeout: effectiveTimeout,
              }),
            );
          }, effectiveTimeout);

          const handler = (value: T) => {
            clearTimeout(timer);
            state.topicSubscribers.delete(handler);
            resolve(value);
          };
          state.topicSubscribers.add(handler);
        });
      }
    }
  }

  tryRecv<T>(channel: Channel<T>): T | null {
    const state = this.getOrCreate(channel);

    switch (state.mode) {
      case 'value':
        return state.hasValue ? (state.currentValue as T) : null;
      case 'queue':
        return state.queue.length > 0 ? state.queue.shift()! : null;
      case 'topic':
        return null;
    }
  }

  private waitWithTimeout<T>(
    waiters: Array<{
      resolve: (v: T) => void;
      reject: (e: Error) => void;
    }>,
    channelName: string,
    timeout: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const wrappedResolve = (v: T) => {
        if (timer) {
          clearTimeout(timer);
        }
        resolve(v);
      };
      const entry = {
        resolve: wrappedResolve,
        reject,
      };
      waiters.push(entry);

      if (timeout > 0) {
        timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx >= 0) {
            waiters.splice(idx, 1);
            reject(
              new OrchidErrorImpl({
                kind: 'channel_timeout',
                channelName,
                timeout,
              }),
            );
          }
        }, timeout);
      }
    });
  }

  getHandle<T>(channel: ExternalChannel<T>, executionId: string): ChannelHandle<T> {
    const store = this;
    return {
      get closed() {
        return store.closedExecutions.has(executionId);
      },
      channel,
      send(value: T) {
        if (store.closedExecutions.has(executionId)) {
          throw new OrchidErrorImpl({
            kind: 'channel_closed',
            channelName: channel.name,
          });
        }
        store.send(channel, value);
      },
    };
  }

  closeExecution(executionId: string): void {
    this.closedExecutions.add(executionId);
  }
}
