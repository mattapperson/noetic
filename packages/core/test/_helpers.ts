/**
 * Shared test helpers — single source of truth for all test factories.
 */
import type { StorageAdapter, ScopedStorage, ExecutionContext } from '../src/types/memory';
import type { ItemLog, Context } from '../src/types/context';
import type { Item, MessageItem, FunctionCallItem, FunctionCallOutputItem } from '../src/types/items';
import type { LLMResponse, Tool } from '../src/types/common';
import { z } from 'zod';

// ── Storage ──────────────────────────────────────────────────────────

function makeMapStorage() {
  const store = new Map<string, unknown>();
  return {
    async get(key: string) { return (store.get(key) as any) ?? null; },
    async set(key: string, value: unknown) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
    async list(prefix?: string) { return [...store.keys()].filter(k => !prefix || k.startsWith(prefix)); },
  };
}

/** Map-backed StorageAdapter that correctly filters by prefix in list(). */
export function makeStorage(): StorageAdapter { return makeMapStorage(); }

/** Map-backed ScopedStorage (prefix is optional in list()). */
export function makeScopedStorage(): ScopedStorage { return makeMapStorage(); }

// ── ExecutionContext ──────────────────────────────────────────────────

export function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'exec-1',
    threadId: 'thread-1',
    resourceId: 'user-1',
    depth: 0,
    ...overrides,
  };
}

// ── ItemLog ──────────────────────────────────────────────────────────

export function makeItemLog(initial: Item[] = []): ItemLog {
  const items: Item[] = [...initial];
  return {
    get items() { return items; },
    append(item: Item) { items.push(item); },
  };
}

// ── Items ────────────────────────────────────────────────────────────

export function makeMessage(
  role: 'system' | 'developer' | 'user' | 'assistant',
  text: string,
  id?: string,
): MessageItem {
  return {
    id: id ?? `msg-${text}`,
    status: 'completed',
    type: 'message',
    role,
    content: [{ type: 'input_text', text }],
  };
}

export function makeFunctionCall(name: string, args: string, id?: string): FunctionCallItem {
  const resolvedId = id ?? `fc-${name}`;
  return {
    id: resolvedId,
    type: 'function_call',
    status: 'completed',
    call_id: `call_${resolvedId}`,
    name,
    arguments: args,
  };
}

export function makeFunctionCallOutput(callId: string, output: string, id?: string): FunctionCallOutputItem {
  return {
    id: id ?? `fco-${callId}`,
    type: 'function_call_output',
    status: 'completed',
    call_id: callId,
    output,
  };
}

// ── Mock Context (full Context interface) ────────────────────────────

export function makeMockContext(overrides?: Partial<Context>): Context {
  return {
    id: 'test-ctx',
    stepCount: 0,
    tokens: { input: 0, output: 0, total: 0 },
    elapsed: 0,
    cost: 0,
    state: {},
    parent: null,
    depth: 0,
    span: {
      traceId: 't',
      spanId: 's',
      parentSpanId: null,
      setAttribute() {},
      addEvent() {},
      end() {},
    },
    threadId: 'thread-1',
    itemLog: makeItemLog(),
    lastStepMeta: null,
    recv: async () => { throw new Error('not impl'); },
    send: () => { throw new Error('not impl'); },
    tryRecv: () => { throw new Error('not impl'); },
    checkpoint: async () => {},
    complete: () => {},
    abort: () => {},
    ...overrides,
  } as Context;
}

// ── LLM Response ─────────────────────────────────────────────────────

export function makeLLMResponse(text: string, overrides?: Partial<LLMResponse>): LLMResponse {
  return {
    items: [{
      id: `resp-${Date.now()}`,
      status: 'completed' as const,
      type: 'message' as const,
      role: 'assistant' as const,
      content: [{ type: 'output_text' as const, text }],
    }],
    usage: { inputTokens: 10, outputTokens: 5 },
    ...overrides,
  };
}

// ── Tools ────────────────────────────────────────────────────────────

export function makeTestTool(overrides?: Partial<Tool<any, any>>): Tool<any, any> {
  return {
    name: 'test-tool',
    description: 'A test tool',
    input: z.object({ query: z.string() }),
    output: z.object({ result: z.string() }),
    execute: async (args: any) => ({ result: `executed: ${args.query}` }),
    ...overrides,
  };
}

// ── Simple execute dispatcher (for loop/fork/spawn tests) ────────────

export const simpleExecute = async <I, O>(step: any, input: I, ctx: Context): Promise<O> => {
  if (step.kind === 'run') return step.execute(input, ctx);
  throw new Error(`Unsupported step kind: ${step.kind}`);
};
