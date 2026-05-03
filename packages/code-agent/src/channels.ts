export interface ChannelTransportFrame {
  channel: string;
  value: unknown;
}

export interface ChannelTransportController {
  receive(frame: ChannelTransportFrame): void;
}

export interface ChannelTransportAdapter {
  start?(controller: ChannelTransportController): void | Promise<void>;
  stop?(): void | Promise<void>;
  publish(frame: ChannelTransportFrame): void | Promise<void>;
  subscribe?(handler: (frame: ChannelTransportFrame) => void): () => void;
}

export function createInMemoryChannelTransportAdapter(): ChannelTransportAdapter {
  const subscribers = new Set<(frame: ChannelTransportFrame) => void>();
  return {
    start(_controller) {},
    stop() {
      subscribers.clear();
    },
    publish(frame) {
      for (const handler of subscribers) {
        handler(frame);
      }
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
  };
}
