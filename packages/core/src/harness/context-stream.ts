import type {
  Context,
  ContextLayer,
  ContextObservation,
  ContextStreamEvent,
  ContextWindow,
  ExecutionContext,
  LayerRecallEvent,
  LayerWindow,
} from '@noetic-tools/types';
import { resolveScopeKey } from './deps/context';

const BUFFER_SIZE = 32;
const IDLE_WINDOW_LIMIT = 32;

interface Thread {
  sequence: number;
  latest?: ContextWindow;
  keys?: ReadonlyMap<string, string>;
  assemblies: Set<(layerId: string, key: string) => void>;
  listeners: Set<(event?: ContextStreamEvent) => void>;
}

/** Session-local, in-memory context observation. Readers never hold up dispatch. */
export class ContextStreams {
  private readonly threads = new Map<string, Thread>();
  private readonly idle = new Set<string>();
  private closed = false;

  constructor(private readonly hasSession: (id: string) => boolean) {}

  current(id: string): ContextWindow | undefined {
    const window = this.threads.get(id)?.latest;
    return window && structuredClone(window);
  }

  stream(id: string): AsyncIterable<ContextStreamEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        if (this.closed) {
          return {
            next: async () => ({
              done: true,
              value: undefined,
            }),
          };
        }
        const thread = this.thread(id);
        return subscribe(thread, () => this.prune(id, thread));
      },
    };
  }

  begin(ctx: Context, stepId: string): ContextObservation | undefined {
    if (this.closed) {
      return undefined;
    }
    let window: ContextWindow = {
      threadId: ctx.threadId,
      executionId: ctx.id,
      parentExecutionId: ctx.parent?.id,
      stepId,
      assemblyId: crypto.randomUUID(),
      status: 'partial',
      layers: [],
    };
    const thread = this.thread(ctx.threadId);
    const keys = new Map<string, string>();
    const scope = {
      executionId: ctx.id,
      resourceId: ctx.resourceId,
      threadId: ctx.threadId,
    };
    const mark = (layerId: string, key: string) => {
      if (keys.get(layerId) === key) {
        window = markPending(window, layerId);
      }
    };
    thread.assemblies.add(mark);
    const send = (
      type: ContextStreamEvent['type'],
      details?: Pick<ContextStreamEvent, 'layerId' | 'pass'>,
    ) => {
      this.publish(thread, window, keys, type, details);
    };
    return {
      layer: (event, pass = 'recall') => {
        const layers = new Map(
          window.layers.map((layer) => [
            layer.layerId,
            layer,
          ]),
        );
        const layerId = event.layer.id;
        const key = layerKey(event.layer, scope);
        keys.set(layerId, key);
        const previous =
          layers.get(layerId) ??
          (thread.keys?.get(layerId) === key
            ? thread.latest?.layers.find((layer) => layer.layerId === layerId)
            : undefined);
        layers.set(event.layer.id, layerWindow(event, previous, pass));
        window = {
          ...window,
          layers: [
            ...layers.values(),
          ],
          status: 'partial',
        };
        send('layer', {
          layerId: event.layer.id,
          pass,
        });
      },
      request: (request) => {
        window = {
          ...window,
          status: 'request',
          request,
        };
        send('request');
      },
      end: () => {
        if (window.status === 'partial' && window.layers.length > 0) {
          window = {
            ...window,
            status: 'ended',
          };
          send('ended');
        }
        thread.assemblies.delete(mark);
        this.prune(ctx.threadId, thread);
      },
    };
  }

  stale(layer: ContextLayer, ctx: ExecutionContext): void {
    const key = layerKey(layer, ctx);
    for (const thread of this.threads.values()) {
      for (const mark of thread.assemblies) {
        mark(layer.id, key);
      }
      if (thread.latest && thread.keys?.get(layer.id) === key) {
        const window = markPending(thread.latest, layer.id);
        if (window !== thread.latest) {
          this.publish(thread, window, thread.keys, 'layer', {
            layerId: layer.id,
          });
        }
      }
    }
  }

  drop(id: string): void {
    const thread = this.threads.get(id);
    this.threads.delete(id);
    this.idle.delete(id);
    if (thread) {
      for (const listener of thread.listeners) {
        listener();
      }
    }
  }

  close(): void {
    this.closed = true;
    for (const id of this.threads.keys()) {
      this.drop(id);
    }
  }

  private thread(id: string): Thread {
    this.idle.delete(id);
    let thread = this.threads.get(id);
    if (!thread) {
      thread = {
        sequence: 0,
        listeners: new Set(),
        assemblies: new Set(),
      };
      this.threads.set(id, thread);
    }
    return thread;
  }

  private prune(id: string, thread: Thread): void {
    if (this.threads.get(id) !== thread || thread.listeners.size || thread.assemblies.size) {
      return;
    }
    if (!thread.latest) {
      this.drop(id);
      return;
    }
    if (this.hasSession(id)) {
      return;
    }
    // Standalone callers can still inspect their latest window, but a harness
    // that runs against a new thread ID each time must not retain every prompt.
    this.idle.add(id);
    if (this.idle.size > IDLE_WINDOW_LIMIT) {
      const oldest = this.idle.values().next().value;
      if (oldest !== undefined) {
        this.drop(oldest);
      }
    }
  }

  private publish(
    thread: Thread,
    window: ContextWindow,
    keys: ReadonlyMap<string, string>,
    type: ContextStreamEvent['type'],
    details?: Pick<ContextStreamEvent, 'layerId' | 'pass'>,
  ): void {
    if (this.closed || this.threads.get(window.threadId) !== thread) {
      return;
    }
    // Capture before the caller can append to its input or change a cached item.
    const snapshot = copyWindow(window);
    thread.latest = snapshot;
    thread.keys = new Map(keys);
    const event = {
      sequence: ++thread.sequence,
      type,
      window: snapshot,
      ...details,
    };
    for (const listener of thread.listeners) {
      listener(event);
    }
  }
}

export function layerWindow(
  event: LayerRecallEvent,
  previous?: LayerWindow,
  pass?: 'recall' | 'rerender',
): LayerWindow {
  const { layer, source, outcome, items, at } = event;
  const pendingUpdate =
    event.pendingUpdate === true || outcome === 'running' || outcome === 'failed';
  const keepsItems =
    outcome === 'running' ||
    outcome === 'failed' ||
    (outcome === 'no-result' && pass === 'rerender');
  return {
    layerId: layer.id,
    name: layer.name ?? layer.id,
    recallMode: layer.recallMode ?? 'atomic',
    items: items ?? (keepsItems ? (previous?.items ?? []) : []),
    source: keepsItems ? previous?.source : source,
    outcome: outcome === 'running' ? previous?.outcome : outcome,
    lastUpdatedAt: keepsItems ? (previous?.lastUpdatedAt ?? null) : (at ?? null),
    pendingUpdate,
  };
}

function subscribe(thread: Thread, prune: () => void): AsyncIterator<ContextStreamEvent> {
  const queue: ContextStreamEvent[] = thread.latest
    ? [
        {
          sequence: thread.sequence,
          type: 'snapshot',
          window: thread.latest,
        },
      ]
    : [];
  const waiting: Array<(result: IteratorResult<ContextStreamEvent>) => void> = [];
  let ended = false;
  const done = {
    done: true,
    value: undefined,
  } as const;
  const close = () => {
    ended = true;
    thread.listeners.delete(read);
    for (const resolve of waiting.splice(0)) {
      resolve(done);
    }
    prune();
  };
  const read = (event?: ContextStreamEvent) => {
    if (!event) {
      close();
    } else if (waiting.length) {
      waiting.shift()?.({
        done: false,
        value: structuredClone(event),
      });
    } else if (queue.length < BUFFER_SIZE) {
      queue.push(event);
    } else {
      queue.splice(0, queue.length, {
        ...event,
        type: 'snapshot',
        gap: true,
        layerId: undefined,
        pass: undefined,
      });
    }
  };
  thread.listeners.add(read);
  return {
    next: () => {
      const event = queue.shift();
      if (event) {
        return Promise.resolve({
          done: false,
          value: structuredClone(event),
        });
      }
      return ended ? Promise.resolve(done) : new Promise((resolve) => waiting.push(resolve));
    },
    return: async () => {
      queue.length = 0;
      close();
      return done;
    },
  };
}

function copyWindow(window: ContextWindow): ContextWindow {
  try {
    return structuredClone(window);
  } catch {
    // Custom item schemas can accept values the host cannot copy. An observer
    // must not change whether the layer or provider receives such input.
    const { layers, request: _request, items: _items, ...ref } = window;
    return {
      ...ref,
      layers: layers.map((layer) => ({
        ...layer,
        items: [],
      })),
      contentUnavailable: true,
    };
  }
}

function layerKey(
  layer: ContextLayer,
  scope: Pick<ExecutionContext, 'executionId' | 'threadId' | 'resourceId'>,
): string {
  return JSON.stringify([
    layer.scope,
    resolveScopeKey(layer.scope, scope),
  ]);
}

function markPending(window: ContextWindow, id: string): ContextWindow {
  if (!window.layers.some((layer) => layer.layerId === id && !layer.pendingUpdate)) {
    return window;
  }
  return {
    ...window,
    layers: window.layers.map((layer) =>
      layer.layerId === id
        ? {
            ...layer,
            pendingUpdate: true,
          }
        : layer,
    ),
  };
}
