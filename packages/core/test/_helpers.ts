/**
 * Shared test helpers — single source of truth for all test factories.
 */

import { expect } from 'bun:test';
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
import type { AgentHarnessContract, CallModelRequest } from '../src/types/runtime';
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
    callId: `call_${resolvedId}`,
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
    callId,
    output,
  };
}

// ── Mock Context (full Context interface) ────────────────────────────

let _sharedMockHarness: AgentHarnessContract | undefined;
function getSharedMockHarness(): AgentHarnessContract {
  if (!_sharedMockHarness) {
    _sharedMockHarness = makeMockHarness();
  }
  return _sharedMockHarness;
}

export function makeMockContext(overrides?: Partial<Context>): Context {
  const harness = overrides?.harness ?? getSharedMockHarness();
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
    harness,
    layers: undefined,
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
        status: 'completed',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
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

export function makeMockHarness(): AgentHarnessContract {
  const harness: AgentHarnessContract = {
    config: {
      name: 'test-harness',
      params: {},
    },
    callModel: async () => {
      throw new Error('not impl');
    },
    execute: async () => {
      throw new Error('not impl');
    },
    run: async () => {
      throw new Error('not impl');
    },
    detachedSpawn: () => {
      throw new Error('not impl');
    },
    createContext: () =>
      makeMockContext({
        harness,
      }),
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
  return harness;
}

/**
 * Creates a mock context whose harness.callModel returns scripted LLM responses
 * in order. Used by tests that exercise code paths requiring an LLM.
 */
export function makeMockContextWithClient(script: LLMResponse[]): Context {
  const harness = makeMockHarness();
  harness.callModel = createScriptedCallModel(script);
  return makeMockContext({
    harness,
  });
}

/**
 * Creates a scripted callModel function that returns responses in order.
 * For use with AgentHarness `_testCallModel` option.
 */
export function createScriptedCallModel(
  script: LLMResponse[],
): (request: CallModelRequest) => Promise<LLMResponse> {
  let callIndex = 0;
  return async () => {
    if (callIndex >= script.length) {
      throw new Error(`Mock callModel exhausted after ${script.length} calls`);
    }
    return script[callIndex++];
  };
}

/**
 * Creates a dynamic callModel function that calls a factory on each invocation.
 * For use with AgentHarness `_testCallModel` option.
 */
export function createDynamicCallModel(
  factory: () => LLMResponse,
): (request: CallModelRequest) => Promise<LLMResponse> {
  return async () => factory();
}

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

//#region Response Factories

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

interface ToolCallResponseOpts {
  toolName: string;
  args: string;
  output: string;
  finalText: string;
}

export function toolCallResponse(opts: ToolCallResponseOpts): LLMResponse {
  const callId = `call_${crypto.randomUUID()}`;
  return {
    items: [
      {
        id: `fc-${callId}`,
        status: 'completed',
        type: 'function_call',
        callId,
        name: opts.toolName,
        arguments: opts.args,
      } satisfies FunctionCallItem,
      {
        id: `fco-${callId}`,
        status: 'completed',
        type: 'function_call_output',
        callId,
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

//#region OpenResponses Compliance

const VALID_ITEM_TYPES = new Set([
  'message',
  'function_call',
  'function_call_output',
  'reasoning',
]);

const VALID_STATUSES = new Set([
  'in_progress',
  'completed',
  'incomplete',
  'failed',
]);

const VALID_CONTENT_PART_TYPES = new Set([
  'output_text',
  'input_text',
  'refusal',
]);

/**
 * Asserts that every item in a log conforms to the OpenResponses item shape.
 * Checks id, status, type discriminator, and per-type field presence.
 */
export function assertOpenResponsesCompliance(items: readonly Item[]): void {
  for (const item of items) {
    expect(typeof item.id).toBe('string');
    expect(item.id.length).toBeGreaterThan(0);
    expect(VALID_STATUSES.has(item.status)).toBe(true);

    const isExtension = item.type.startsWith('x-');
    if (!isExtension) {
      expect(VALID_ITEM_TYPES.has(item.type)).toBe(true);
    }

    if (item.type === 'message') {
      expect(Array.isArray(item.content)).toBe(true);
      for (const part of item.content) {
        expect(VALID_CONTENT_PART_TYPES.has(part.type)).toBe(true);
      }
    }

    if (item.type === 'function_call') {
      expect(typeof item.callId).toBe('string');
      expect(typeof item.name).toBe('string');
      expect(typeof item.arguments).toBe('string');
    }

    if (item.type === 'function_call_output') {
      expect(typeof item.callId).toBe('string');
      expect(typeof item.output).toBe('string');
    }
  }
}

//#endregion
