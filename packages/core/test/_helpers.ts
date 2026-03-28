/**
 * Shared test helpers — single source of truth for all test factories.
 */

import { z } from 'zod';
import { frameworkCast } from '../src/interpreter/framework-cast';
import type { LLMResponse, Tool } from '../src/types/common';
import type { Context, ItemLog } from '../src/types/context';
import type { EmbedFn } from '../src/types/embed';
import type {
  FunctionCallItem,
  FunctionCallOutputItem,
  Item,
  MessageItem,
} from '../src/types/items';
import type { ExecutionContext, ScopedStorage, StorageAdapter } from '../src/types/memory';
import type { AgentHarness } from '../src/types/runtime';
import { SteeringAction } from '../src/types/steering';
import type { ExecuteStepFn, Step } from '../src/types/step';
import type { ToolExecutionContext } from '../src/types/tool-context';

// ── Storage ──────────────────────────────────────────────────────────

function makeMapStorage() {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | null> {
      const val = store.get(key);
      // SAFETY: values are stored via set(key, value: unknown); the caller is
      // responsible for reading back with the same type T they stored.
      return val === undefined ? null : frameworkCast<T>(val);
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(prefix?: string): Promise<string[]> {
      return [
        ...store.keys(),
      ].filter((k) => !prefix || k.startsWith(prefix));
    },
  };
}

/** Map-backed StorageAdapter that correctly filters by prefix in list(). */
export function makeStorage(): StorageAdapter {
  return makeMapStorage();
}

/** Map-backed ScopedStorage (prefix is optional in list()). */
export function makeScopedStorage(): ScopedStorage {
  return makeMapStorage();
}

// ── ExecutionContext ──────────────────────────────────────────────────

export function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'exec-1',
    threadId: 'thread-1',
    resourceId: 'user-1',
    depth: 0,
    stepNumber: 0,
    tokenUsage: {
      input: 0,
      output: 0,
    },
    cost: 0,
    tokenize: (text: string) => Math.ceil(text.length / 4),
    trace: {
      setAttribute() {},
      addEvent() {},
    },
    ...overrides,
  };
}

// ── ItemLog ──────────────────────────────────────────────────────────

export function makeItemLog(initial: Item[] = []): ItemLog {
  const items: Item[] = [
    ...initial,
  ];
  return {
    get items() {
      return items;
    },
    append(item: Item) {
      items.push(item);
    },
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
    content: [
      {
        type: 'input_text',
        text,
      },
    ],
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

export function makeFunctionCallOutput(
  callId: string,
  output: string,
  id?: string,
): FunctionCallOutputItem {
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
    tokens: {
      input: 0,
      output: 0,
      total: 0,
    },
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
    recv: async () => {
      throw new Error('not impl');
    },
    send: () => {
      throw new Error('not impl');
    },
    tryRecv: () => {
      throw new Error('not impl');
    },
    checkpoint: async () => {},
    complete: () => {},
    completed: false,
    completionValue: undefined,
    aborted: false,
    abort: () => {},
    ...overrides,
  };
}

// ── LLM Response ─────────────────────────────────────────────────────

export function makeLLMResponse(text: string, overrides?: Partial<LLMResponse>): LLMResponse {
  return {
    items: [
      {
        id: `resp-${Date.now()}`,
        status: 'completed' as const,
        type: 'message' as const,
        role: 'assistant' as const,
        content: [
          {
            type: 'output_text' as const,
            text,
          },
        ],
      },
    ],
    usage: {
      inputTokens: 10,
      outputTokens: 5,
    },
    ...overrides,
  };
}

// ── Tools ────────────────────────────────────────────────────────────

type TestToolInput = {
  query: string;
};
type TestToolOutput = {
  result: string;
};

export function makeTestTool(
  overrides?: Partial<
    Tool<
      z.ZodObject<{
        query: z.ZodString;
      }>,
      z.ZodObject<{
        result: z.ZodString;
      }>
    >
  >,
): Tool<
  z.ZodObject<{
    query: z.ZodString;
  }>,
  z.ZodObject<{
    result: z.ZodString;
  }>
> {
  return {
    name: 'test-tool',
    description: 'A test tool',
    input: z.object({
      query: z.string(),
    }),
    output: z.object({
      result: z.string(),
    }),
    execute: async (args: TestToolInput): Promise<TestToolOutput> => ({
      result: `executed: ${args.query}`,
    }),
    ...overrides,
  };
}

// ── Mock EmbedFn ─────────────────────────────────────────────────────

export function mockEmbed(vectors: Record<string, number[]>): EmbedFn {
  return async (texts: readonly string[]): Promise<readonly number[][]> => {
    return texts.map(
      (t) =>
        vectors[t] ?? [
          0,
          0,
          0,
        ],
    );
  };
}

// ── Mock ToolExecutionContext ─────────────────────────────────────────

export function makeMockToolContext(ctx?: Context): ToolExecutionContext {
  const resolvedCtx = ctx ?? makeMockContext();
  return {
    ctx: resolvedCtx,
    harness: makeMockHarness(),
    memory: {
      get: () => undefined,
      set: () => {},
    },
    assembledView: resolvedCtx.itemLog.items,
    lastStepMeta: null,
  };
}

export function makeMockHarness(): AgentHarness {
  return {
    run: async () => {
      throw new Error('not impl');
    },
    detachedSpawn: () => {
      throw new Error('not impl');
    },
    createContext: () => makeMockContext(),
    send: () => {},
    recv: async () => {
      throw new Error('not impl');
    },
    tryRecv: () => null,
    getChannelHandle: () => {
      throw new Error('not impl');
    },
    initLayers: async () => {},
    recallLayers: async () => [],
    storeLayers: async () => {},
    disposeLayers: async () => {},
    assembleView: async (_agent, _input, ctx) => [
      ...ctx.itemLog.items,
    ],
    checkpoint: async () => {},
    restore: async () => null,
    cancel: async () => {},
    createSpan: (name) => ({
      traceId: 't',
      spanId: name,
      parentSpanId: null,
      setAttribute() {},
      addEvent() {},
      end() {},
    }),
    getLayerState: () => undefined,
    setLayerState: () => {},
    beforeToolCall: async () => ({
      action: SteeringAction.Allow,
    }),
    afterModelCall: async () => ({
      action: SteeringAction.Allow,
    }),
  };
}

/** @deprecated Use makeMockHarness instead. */
export const makeMockRuntime = makeMockHarness;

// ── Simple execute dispatcher (for loop/fork/spawn tests) ────────────

export const simpleExecute: ExecuteStepFn = async <I, O>(
  step: Step<I, O>,
  input: I,
  ctx: Context,
): Promise<O> => {
  if (step.kind === 'run') {
    return step.execute(input, ctx);
  }
  throw new Error(`Unsupported step kind: ${step.kind}`);
};

//#region Scripted Call Model

type MockCallModelScript = LLMResponse[];

interface ToolCallResponseOpts {
  toolName: string;
  args: string;
  output: string;
  finalText: string;
}

/** Creates a mock callModel that returns scripted LLM responses in order. */
export function createScriptedCallModel(script: MockCallModelScript): () => Promise<LLMResponse> {
  let callIndex = 0;
  return async (): Promise<LLMResponse> => {
    if (callIndex >= script.length) {
      throw new Error(`Mock callModel exhausted after ${script.length} calls`);
    }
    return script[callIndex++];
  };
}

export function assistantMessage(text: string, id?: string): MessageItem {
  return {
    id: id ?? `msg-${crypto.randomUUID()}`,
    status: 'completed',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text,
      },
    ],
  };
}

export function toolCallResponse(opts: ToolCallResponseOpts): LLMResponse {
  const callId = `call_${crypto.randomUUID()}`;
  return {
    items: [
      {
        id: `fc-${callId}`,
        status: 'completed',
        type: 'function_call',
        call_id: callId,
        name: opts.toolName,
        arguments: opts.args,
      } satisfies FunctionCallItem,
      {
        id: `fco-${callId}`,
        status: 'completed',
        type: 'function_call_output',
        call_id: callId,
        output: opts.output,
      } satisfies FunctionCallOutputItem,
      assistantMessage(opts.finalText),
    ],
    usage: {
      inputTokens: 50,
      outputTokens: 30,
    },
    cost: 0.001,
  };
}

export function textOnlyResponse(text: string): LLMResponse {
  return makeLLMResponse(text, {
    cost: 0.001,
  });
}

//#endregion
