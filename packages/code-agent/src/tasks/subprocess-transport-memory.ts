export interface TaskRunTransportFrame {
  runId: string;
  type: string;
  payload?: unknown;
}

export interface TaskRunTransportAdapter {
  publish(frame: TaskRunTransportFrame): Promise<void> | void;
  subscribe(runId: string, handler: (frame: TaskRunTransportFrame) => void): () => void;
  history(runId: string): Promise<ReadonlyArray<TaskRunTransportFrame>>;
  stop?(): Promise<void> | void;
}

export function createInMemoryTaskRunTransport(): TaskRunTransportAdapter {
  const frames = new Map<string, TaskRunTransportFrame[]>();
  const subscribers = new Map<string, Set<(frame: TaskRunTransportFrame) => void>>();

  return {
    publish(frame) {
      const history = frames.get(frame.runId) ?? [];
      history.push(frame);
      frames.set(frame.runId, history);
      for (const handler of subscribers.get(frame.runId) ?? []) {
        handler(frame);
      }
    },
    subscribe(runId, handler) {
      let handlers = subscribers.get(runId);
      if (!handlers) {
        handlers = new Set();
        subscribers.set(runId, handlers);
      }
      handlers.add(handler);
      return () => {
        handlers?.delete(handler);
      };
    },
    async history(runId) {
      return [
        ...(frames.get(runId) ?? []),
      ];
    },
    stop() {
      subscribers.clear();
    },
  };
}
