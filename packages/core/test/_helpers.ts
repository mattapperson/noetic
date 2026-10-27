/**
 * Shared test helpers — single source of truth for all test factories.
 */

import { expect } from 'bun:test';
import * as fsp from 'node:fs/promises';
import type {
  ContextData,
  FsAdapter,
  FsStats,
  ShellAdapter,
  ToolContext,
} from '@noetic-tools/types';
import { z } from 'zod';
import { createInMemorySubprocessAdapter } from '../src/adapters/in-memory-subprocess-adapter';
import { callDecide } from '../src/harness/decide-call';

//#region Test-only Node adapters
//
// Core is runtime-agnostic and ships no `node:*` adapters; those live in
// `@noetic-tools/platform-node`. Core tests that exercise filesystem-dependent
// context layers need real disk access, so we inline a minimal
// Node-backed `FsAdapter` and a no-op `ShellAdapter` here. Keeping these
// helpers local to `test/` prevents the production bundle from pulling
// `node:fs/promises`.

function toFsStats(s: {
  size: number;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  isFile: () => boolean;
}): FsStats {
  return {
    size: s.size,
    isDirectory: () => s.isDirectory(),
    isSymbolicLink: () => s.isSymbolicLink(),
    isFile: () => s.isFile(),
  };
}

function createNodeFsAdapter(): FsAdapter {
  return {
    readFile: async (p) => fsp.readFile(p),
    readFileText: async (p) => fsp.readFile(p, 'utf-8'),
    writeFile: async (p, content) => fsp.writeFile(p, content, 'utf-8'),
    writeFileBytes: async (p, content) => fsp.writeFile(p, content),
    appendFile: async (p, content) => fsp.appendFile(p, content, 'utf-8'),
    mkdir: async (dir) => {
      await fsp.mkdir(dir, {
        recursive: true,
      });
    },
    rename: async (o, n) => fsp.rename(o, n),
    rm: async (p, options) => {
      await fsp.rm(p, options);
    },
    access: async (p, mode) => fsp.access(p, mode),
    stat: async (p) => toFsStats(await fsp.stat(p)),
    lstat: async (p) => toFsStats(await fsp.lstat(p)),
    readdir: async (p) => fsp.readdir(p),
  };
}

function createNoopShellAdapter(): ShellAdapter {
  return {
    exec: async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }),
  };
}

import type {
  BudgetConfig,
  ContextLayer,
  ContextScope,
  ExecutionContext,
  ScopedStorage,
  StorageAdapter,
} from '@noetic-tools/context';
import { createContextCacheStore } from '@noetic-tools/context';
//#endregion
import type {
  AgentHarnessContract,
  CallModelRequest,
  Context,
  ExecuteStepFn,
  FunctionCallItem,
  FunctionCallOutputItem,
  InputMessageItem,
  Item,
  ItemLog,
  LLMResponse,
  MessageItem,
  Step,
  Tool,
  ToolExecutionContext,
} from '@noetic-tools/types';
import { frameworkCast, SteeringAction } from '@noetic-tools/types';
import { runToReturn } from '../src/interpreter/emit-items';
import type { EmbedFn } from '../src/types/embed';

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
    async getMany<T>(keys: string[]): Promise<Map<string, T>> {
      const found = new Map<string, T>();
      for (const key of keys) {
        const val = store.get(key);
        if (val === undefined) {
          continue;
        }
        found.set(key, frameworkCast<T>(val));
      }
      return found;
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
    fs: createNodeFsAdapter(),
    shell: createNoopShellAdapter(),
    tokenize: (text: string) => Math.ceil(text.length / 4),
    trace: {
      setAttribute() {},
      addEvent() {},
    },
    readLayerState: <T>(_layerId: string): T | undefined => undefined,
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
  role: 'system' | 'developer' | 'user',
  text: string,
  id?: string,
): InputMessageItem;
export function makeMessage(role: 'assistant', text: string, id?: string): MessageItem;
export function makeMessage(
  role: 'system' | 'developer' | 'user' | 'assistant',
  text: string,
  id?: string,
): InputMessageItem | MessageItem {
  if (role === 'assistant') {
    return frameworkCast<MessageItem>({
      id: id ?? `msg-${text}`,
      status: 'completed',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text,
        },
      ],
    });
  }
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
  // One object behind both accessors, exactly as ContextImpl does — a mock that
  // let them diverge would hide compat bugs instead of catching them.
  const contextData: ContextData = {};
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
    billedCost: 0,
    heldCost: 0,
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
    lastLayerUsage: undefined,
    harness,
    fs: harness.fs,
    shell: harness.shell,
    subprocess: harness.subprocess,
    cwdState: {
      cwd: process.cwd(),
    },
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
    context: overrides?.context ?? contextData,
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
  const harness = makeMockHarness();
  const toolContext: ToolContext = {
    get: () => undefined,
    set: () => {},
  };
  return {
    ctx: resolvedCtx,
    harness,
    fs: harness.fs,
    shell: harness.shell,
    context: toolContext,
    assembledView: resolvedCtx.itemLog.items,
    lastStepMeta: null,
  };
}

/** A branch-route `run` for tests whose routes never run a step. */
export const noRun: ExecuteStepFn = async () => {
  throw new Error('route ran a step in a test that expects it not to');
};

export function makeMockHarness(): AgentHarnessContract {
  const harness: AgentHarnessContract = {
    config: {
      name: 'test-harness',
      params: {},
    },
    fs: createNodeFsAdapter(),
    shell: createNoopShellAdapter(),
    subprocess: createInMemorySubprocessAdapter(),
    contextCache: createContextCacheStore(),
    callModel: async () => {
      throw new Error('not impl');
    },
    // The estimated path over whatever `callModel` the test installs.
    decide: (request) =>
      callDecide(request, {
        callModel: (r) => harness.callModel(r),
        nativeModels: new Map(),
      }),
    notifyDecision: async () => {},
    execute: async () => {
      throw new Error('not impl');
    },
    getAgentResponse: async () => {
      throw new Error('not impl');
    },
    getItemStream: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({
            done: true,
            value: undefined,
          }),
        };
      },
    }),
    getTextStream: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({
            done: true,
            value: undefined,
          }),
        };
      },
    }),
    getReasoningStream: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({
            done: true,
            value: undefined,
          }),
        };
      },
    }),
    getFullStream: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({
            done: true,
            value: undefined,
          }),
        };
      },
    }),
    abort: async () => {},
    getStatus: () => ({
      kind: 'idle',
    }),
    getQueueSize: () => 0,
    getUsage: () => ({
      inputTokens: 0,
      outputTokens: 0,
    }),
    seedSessionHistory: () => {},
    rootCwdState: {
      cwd: process.cwd(),
    },
    setRootCwd: () => {},
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
    send: async () => {},
    recv: async () => {
      throw new Error('not impl');
    },
    tryRecv: () => null,
    getChannelHandle: () => {
      throw new Error('not impl');
    },
    getChannelStream: () => {
      throw new Error('not impl');
    },
    initLayers: async () => {},
    recallLayers: async () => [],
    // Default to delegating atomic recall to recallLayers so tests that mock
    // recallLayers keep working; eventual recall contributes nothing by default.
    recallLayersAtomic: async (layers, input, ctx) => harness.recallLayers(layers, input, ctx),
    recallLayersEventual: async () => [],
    previewRequestItems: async () => [],
    storeLayers: async () => {},
    disposeLayers: async () => {},
    checkpoint: async () => {},
    restore: async () => null,
    cancel: async () => {},
    traceExporter: {
      export: async () => {},
    },
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
    projectHistory: async (_layers, items) => items,
    runAppendPipeline: async (_layers, items) => ({
      items,
      rerenderRequests: [],
    }),
    executeRerender: async () => [],
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
 * Do `work` inside a run on `ctx` that never completes, as a host that dies the moment
 * `work` finishes: every step `work` dispatches records to the ledger, but the
 * checkpoint still points at the run's start — exactly what a crash leaves behind. The
 * wrapping step has no id, so what `work` dispatches keeps its top-level paths.
 */
export async function crashAfter<T>(
  harness: AgentHarnessContract,
  ctx: Context,
  work: (execCtx: Context) => Promise<T>,
): Promise<T> {
  let output: T | undefined;
  const host = frameworkCast<
    Step<Readonly<Record<string, Record<string, unknown>>>, string, string>
  >({
    kind: 'runCode',
    id: '',
    execute: async (_input: string, execCtx: Context) => {
      output = await work(execCtx);
      throw new Error('host died');
    },
  });
  await harness.run(host, '', ctx).catch((error: unknown) => {
    if (!(error instanceof Error) || !error.message.includes('host died')) {
      throw error;
    }
  });
  return frameworkCast<T>(output);
}

/** `crashAfter` running one step — see there. Returns the step's output. */
export function runThenCrash<I, O>(
  harness: AgentHarnessContract,
  step: Step<Readonly<Record<string, Record<string, unknown>>>, I, O>,
  input: I,
  ctx: Context,
): Promise<O> {
  return crashAfter(harness, ctx, (execCtx) => harness.run(step, input, execCtx));
}

/** Wall-clock sleep for tests that exercise real timers. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// ── Simple execute dispatcher (for loop/inParallel/spawn tests) ────────────

export const simpleExecute: ExecuteStepFn = async <TContext, I, O>(
  step: Step<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
): Promise<O> => {
  if (step.kind === 'runCode') {
    return frameworkCast<O>(await runToReturn(step.execute(input, ctx), async () => {}));
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
  'web_search_call',
  'file_search_call',
  'image_generation_call',
]);

const VALID_STATUSES = new Set([
  'in_progress',
  'completed',
  'incomplete',
  'failed',
  'searching',
  'generating',
]);

/** Returns `item.id` when the variant carries one; `undefined` otherwise. */
export function getItemId(item: Item): string | undefined {
  if ('id' in item && typeof item.id === 'string') {
    return item.id;
  }
  return undefined;
}

/**
 * Asserts that every item in a log conforms to the OpenResponses item shape.
 * Checks id, status, type discriminator, and per-type field presence.
 */
export function assertOpenResponsesCompliance(items: readonly Item[]): void {
  for (const item of items) {
    // id may be optional on some SDK output types (e.g., FunctionCallItem)
    if ('id' in item && item.id !== undefined) {
      expect(typeof item.id).toBe('string');
    }
    // status may be optional on some SDK output types
    if ('status' in item && item.status !== undefined) {
      expect(VALID_STATUSES.has(String(item.status))).toBe(true);
    }

    const isExtension = item.type.includes(':');
    if (!isExtension) {
      expect(VALID_ITEM_TYPES.has(item.type)).toBe(true);
    }

    if (item.type === 'message' && 'content' in item) {
      expect(Array.isArray(item.content)).toBe(true);
    }

    if (item.type === 'function_call' && 'callId' in item) {
      expect(typeof item.callId).toBe('string');
      expect(typeof item.name).toBe('string');
      expect(typeof item.arguments).toBe('string');
    }

    if (item.type === 'function_call_output' && 'callId' in item) {
      expect(typeof item.callId).toBe('string');
      expect(typeof item.output).toBe('string');
    }
  }
}

//#endregion

// ── Type Guards ─────────────────────────────────────────────────────

export function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * Structural ContextLayer with no behaviour — for tests that only care that a
 * layer with a given id/slot reached the runtime, not what it does.
 *
 * Pass `hooks` when the test needs the layer to actually participate in the
 * lifecycle; the default is an inert layer.
 */
export function makeLayer(
  id: string,
  opts?: {
    slot?: number;
    scope?: ContextScope;
    budget?: BudgetConfig;
    hooks?: ContextLayer['hooks'];
  },
): ContextLayer {
  return {
    id,
    name: id,
    slot: opts?.slot ?? 100,
    scope: opts?.scope ?? 'execution',
    ...(opts?.budget === undefined
      ? {}
      : {
          budget: opts.budget,
        }),
    hooks: opts?.hooks ?? {},
  };
}

//#region Fake OpenRouter

/** One round the fake server answered: what it was sent, and what it replied. */
export interface FakeOpenRouterRound {
  input: unknown[];
}

/**
 * A stand-in for the OpenRouter Responses API, for tests that drive the harness's real
 * model client. `reply(input)` answers each round from the conversation it was sent,
 * as a model would; rounds whose 1-based number is in `dropAt` stream part of a
 * response and then end, as a lost connection does, and rounds in `hangAt` send their
 * headers and first event and then nothing, as a host killed mid-stream sees. Every
 * response carries the generation id `gen-<round>` in its `x-generation-id` header.
 *
 * A native decide call (`POST /api/alpha/decisions`, under `origin`) gets its headers,
 * with the id `gen-dec-<n>`, and then never its body.
 */
export interface FakeOpenRouter {
  readonly baseUrl: string;
  readonly origin: string;
  readonly rounds: FakeOpenRouterRound[];
  readonly dropAt: Set<number>;
  readonly hangAt: Set<number>;
  stop(): void;
}

export function startFakeOpenRouter(reply: (input: unknown[]) => unknown[]): FakeOpenRouter {
  const rounds: FakeOpenRouterRound[] = [];
  const dropAt = new Set<number>();
  const hangAt = new Set<number>();
  let decisions = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      // Only model rounds are served; model and generation lookups find nothing.
      if (request.method !== 'POST') {
        return new Response('{}', {
          status: 404,
        });
      }
      if (new URL(request.url).pathname === '/api/alpha/decisions') {
        decisions += 1;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"answers":'));
            },
          }),
          {
            headers: {
              'content-type': 'application/json',
              'x-generation-id': `gen-dec-${decisions}`,
            },
          },
        );
      }
      const body = z
        .object({
          model: z.string(),
          input: z.array(z.unknown()).default([]),
        })
        .parse(await request.json());
      rounds.push({
        input: body.input,
      });
      const round = rounds.length;
      const stream = fakeResponseStream(round, body.model, reply(body.input));
      const headers = {
        'content-type': 'text/event-stream',
        'x-generation-id': `gen-${round}`,
      };
      if (hangAt.has(round)) {
        const firstEvent = stream.slice(0, stream.indexOf('\n\n') + 2);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(firstEvent));
            },
          }),
          {
            headers,
          },
        );
      }
      if (!dropAt.has(round)) {
        return new Response(stream, {
          headers,
        });
      }
      const cut = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stream.slice(0, 40)));
          setTimeout(() => controller.close(), 10);
        },
      });
      return new Response(cut, {
        headers,
      });
    },
  });
  return {
    baseUrl: `http://localhost:${server.port}/api/v1`,
    origin: `http://localhost:${server.port}`,
    rounds,
    dropAt,
    hangAt,
    stop: () => server.stop(true),
  };
}

function fakeResponseStream(round: number, model: string, output: unknown[]): string {
  const response = {
    id: `resp_${round}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1e3),
    completed_at: Math.floor(Date.now() / 1e3),
    model,
    status: 'completed',
    error: null,
    frequency_penalty: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    presence_penalty: null,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    output,
    usage: {
      input_tokens: 10,
      input_tokens_details: {
        cached_tokens: 0,
      },
      output_tokens: 5,
      output_tokens_details: {
        reasoning_tokens: 0,
      },
      total_tokens: 15,
      cost: 0.01,
    },
  };
  const events = [
    {
      type: 'response.created',
      sequence_number: 0,
      response: {
        ...response,
        status: 'in_progress',
        output: [],
      },
    },
    {
      type: 'response.completed',
      sequence_number: 1,
      response,
    },
  ];
  return `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`;
}

//#endregion
