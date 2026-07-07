import type {
  ExecutionContext,
  Item,
  ItemLog,
  LLMResponse,
  ScopedStorage,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { createLibrary, defineComponent } from '../src/library';

/** A minimal mutable ItemLog seeded with `items`. */
export function makeItemLog(items: Item[] = []): ItemLog {
  const store = [
    ...items,
  ];
  return {
    get items(): ReadonlyArray<Item> {
      return store;
    },
    append(item: Item): void {
      store.push(item);
    },
  };
}

/** In-memory ScopedStorage backed by a Map. */
export function makeStorage(seed?: Record<string, unknown>): ScopedStorage & {
  data: Map<string, unknown>;
} {
  const data = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    data,
    async get<T>(key: string): Promise<T | null> {
      const value = data.get(key);
      if (value === undefined) {
        return null;
      }
      // Identity read of what the paired `set` wrote — the framework cast
      // bridges the untyped store, as real StorageAdapter backends do.
      return frameworkCast<T>(value);
    },
    async set<T>(key: string, value: T): Promise<void> {
      data.set(key, value);
    },
    async delete(key: string): Promise<void> {
      data.delete(key);
    },
    async list(prefix?: string): Promise<string[]> {
      return [
        ...data.keys(),
      ].filter((k) => k.startsWith(prefix ?? ''));
    },
  };
}

/** Minimal ExecutionContext with a recording trace. */
export function makeExecCtx(): ExecutionContext & {
  traceEvents: Array<{
    name: string;
    attributes?: Record<string, string | number | boolean>;
  }>;
} {
  const traceEvents: Array<{
    name: string;
    attributes?: Record<string, string | number | boolean>;
  }> = [];
  return {
    traceEvents,
    executionId: 'exec-1',
    threadId: 'thread-1',
    depth: 0,
    stepNumber: 0,
    tokenUsage: {
      input: 0,
      output: 0,
    },
    cost: 0,
    // No layer under test touches the filesystem or shell.
    fs: frameworkCast<ExecutionContext['fs']>({}),
    shell: frameworkCast<ExecutionContext['shell']>({}),
    tokenize: (text: string) => Math.ceil(text.length / 4),
    trace: {
      setAttribute: () => {},
      addEvent: (name, attributes) => {
        traceEvents.push({
          name,
          attributes,
        });
      },
    },
    readLayerState: () => undefined,
  };
}

/** An assistant message Item carrying `text`. */
export function assistantItem(text: string): Item {
  return {
    id: crypto.randomUUID(),
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text,
      },
    ],
  };
}

/** An LLMResponse whose only item is an assistant message with `text`. */
export function makeResponse(text: string): LLMResponse {
  return {
    items: [
      assistantItem(text),
    ],
    usage: {
      inputTokens: 10,
      outputTokens: 10,
    },
  };
}

/** The shared test component library. */
export function testLibrary() {
  return createLibrary([
    defineComponent({
      name: 'Card',
      description: 'A titled container',
      props: z.object({
        title: z.string(),
        children: z.array(z.unknown()).optional(),
      }),
    }),
    defineComponent({
      name: 'Text',
      props: z.object({
        value: z.string(),
      }),
    }),
    defineComponent({
      name: 'Progress',
      props: z.object({
        pct: z.number().min(0).max(100),
      }),
    }),
    defineComponent({
      name: 'Stack',
      props: z.object({
        children: z.array(z.unknown()),
      }),
    }),
  ]);
}
