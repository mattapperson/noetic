import type {
  AgentConfig,
  AgentHarnessContract,
  AgentHooks,
  CallModelRequest,
  Channel,
  ChannelHandle,
  Context,
  ContextMemory,
  CwdState,
  DeliveryMode,
  DetachedHandle,
  ExecuteInput,
  ExecuteOptions,
  ExternalChannel,
  FsAdapter,
  HarnessResponse,
  HarnessStatus,
  Item,
  ItemSchemaExtensions,
  LLMResponse,
  MemoryLayer,
  RecallLayerOutput,
  SessionScope,
  ShellAdapter,
  Span,
  SteeringDecision,
  Step,
  StorageAdapter,
  StreamEvent,
  StreamingItem,
  SubprocessAdapter,
  Tool,
  TraceExporter,
} from '@noetic/core';
import {
  AgentHarness,
  branch,
  createInMemoryFsAdapter,
  createInMemoryShellAdapter,
  createInMemoryStorage,
  durableTaskState,
  historyWindow,
  loop,
  observationalMemory,
  planMemory,
  step,
  tool,
  toolMemoryLayer,
  until,
  workingMemory,
} from '@noetic/core/portable';
import { frameworkCast } from '@noetic/core/unstable';
import { z } from 'zod';
import { actAgent } from './agents/act.js';
import { fixAgent } from './agents/fix.js';
import { flowMemory, readFlowState } from './agents/flow-state.js';
import { planAgent } from './agents/plan.js';
import { CODE_AGENT_DONE_SENTINEL } from './agents/shared.js';
import { verifyAgent, verifyAndCheck } from './agents/verify.js';
import type {
  ChannelTransportAdapter,
  ChannelTransportController,
  ChannelTransportFrame,
} from './channels.js';
import { createInMemoryChannelTransportAdapter } from './channels.js';

//#region Types

export interface CodeAgentParams {
  [key: string]: unknown;
  model: string;
}

export interface CodeAgentModelAdapter {
  callModel(request: CallModelRequest): Promise<LLMResponse>;
}

export interface CodeAgentAdapters {
  fs?: FsAdapter;
  shell?: ShellAdapter;
  subprocess?: SubprocessAdapter;
  storage?: StorageAdapter;
  channels?: ChannelTransportAdapter;
  tasks?: TaskStoreAdapter;
  pluginStorage?: (pluginName: string, scope: PluginStorageScope) => StorageAdapter;
}

export interface TaskStoreAdapter {
  list(): Promise<ReadonlyArray<CodeAgentTask>>;
  create(input: CreateCodeAgentTaskInput): Promise<CodeAgentTask>;
  update(
    id: string,
    patch: Partial<Omit<CodeAgentTask, 'id' | 'createdAt'>>,
  ): Promise<CodeAgentTask>;
  get(id: string): Promise<CodeAgentTask | null>;
}

export interface CodeAgentPluginContext {
  cwd: string;
  model: string;
  fs: FsAdapter;
  shell: ShellAdapter;
  channels: ChannelController;
  tasks: TaskController;
  pluginStorage(scope: PluginStorageScope): StorageAdapter;
}

export type PluginStorageScope = 'project' | 'user';

export interface CodeAgentSkill {
  name: string;
  description?: string;
  instructions: string;
  metadata?: Record<string, unknown>;
}

export interface CodeAgentPlugin {
  name: string;
  version: string;
  tools?:
    | ReadonlyArray<Tool>
    | ((ctx: CodeAgentPluginContext) => ReadonlyArray<Tool> | Promise<ReadonlyArray<Tool>>);
  memoryLayers?:
    | ReadonlyArray<MemoryLayer>
    | ((
        ctx: CodeAgentPluginContext,
      ) => ReadonlyArray<MemoryLayer> | Promise<ReadonlyArray<MemoryLayer>>);
  skills?:
    | ReadonlyArray<CodeAgentSkill>
    | ((
        ctx: CodeAgentPluginContext,
      ) => ReadonlyArray<CodeAgentSkill> | Promise<ReadonlyArray<CodeAgentSkill>>);
  initialize?: (ctx: CodeAgentPluginContext) => Promise<void> | void;
  dispose?: () => Promise<void> | void;
}

export interface CreateCodeAgentOptions {
  name?: string;
  model: string;
  cwd?: string;
  instructions?: string;
  adapters?: CodeAgentAdapters;
  plugins?: ReadonlyArray<CodeAgentPlugin>;
  tools?: ReadonlyArray<Tool>;
  memory?: ReadonlyArray<MemoryLayer>;
  /**
   * Whether to install the SDK's portable default memory stack. Hosts that
   * supply a complete product memory stack, such as the CLI, should set this
   * to false and pass `memory` explicitly.
   */
  defaultMemory?: boolean;
  hooks?: AgentHooks;
  modelAdapter?: CodeAgentModelAdapter;
  llm?: {
    provider: 'openrouter';
    apiKey?: string;
  };
  itemSchemas?: ItemSchemaExtensions;
  strictItemSchemas?: boolean;
  traceExporter?: TraceExporter;
  defaultDeliveryMode?: DeliveryMode;
  streamIdleTimeoutMs?: number;
  /** Line-count threshold (insertions + deletions) above which the act agent's output is routed to verify. Default 5. */
  verifyThreshold?: number;
  /** Hard ceiling on verify→fix iterations before giving up. Default 3. */
  maxFixAttempts?: number;
}

export type {
  CodeAgentFlowState,
  CodeAgentMode,
  CodeAgentPlanApprovalQuestion,
} from './agents/flow-state.js';

export interface CodeAgentSessionSnapshot {
  id: string;
  cwd: string;
  status: HarnessStatus;
  queueSize: number;
}

export interface SkillController {
  list(): ReadonlyArray<CodeAgentSkill>;
  get(name: string): CodeAgentSkill | null;
}

export interface ToolController {
  list(): ReadonlyArray<Tool>;
  get(name: string): Tool | null;
}

export interface TaskController {
  list(): Promise<ReadonlyArray<CodeAgentTask>>;
  create(input: CreateCodeAgentTaskInput): Promise<CodeAgentTask>;
  update(
    id: string,
    patch: Partial<Omit<CodeAgentTask, 'id' | 'createdAt'>>,
  ): Promise<CodeAgentTask>;
  get(id: string): Promise<CodeAgentTask | null>;
}

export interface CreateCodeAgentTaskInput {
  title: string;
  body?: string;
  status?: CodeAgentTaskStatus;
}

export type CodeAgentTaskStatus = 'todo' | 'in_progress' | 'done';

export interface CodeAgentTask {
  id: string;
  title: string;
  body: string;
  status: CodeAgentTaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SubagentController {
  list(): ReadonlyArray<DetachedHandle<unknown>>;
  track<T>(handle: DetachedHandle<T>): void;
}

export interface ChannelController {
  publish<T>(channel: Channel<T>, value: T, ctx?: Context): Promise<void>;
  subscribe<T>(channel: Channel<T>, handler: (value: T) => void): () => void;
  recv<T>(
    channel: Channel<T>,
    ctx: Context,
    opts?: {
      timeout?: number;
    },
  ): Promise<T>;
  tryRecv<T>(channel: Channel<T>, ctx: Context): T | null;
  getHandle<T>(channel: ExternalChannel<T>, executionId: string): ChannelHandle<T>;
}

export interface CodeAgent<TParams extends Record<string, unknown> = CodeAgentParams>
  extends AgentHarnessContract<TParams> {
  readonly kind: 'code-agent';
  readonly sessionId: string;
  readonly cwd: string;
  readonly harness: AgentHarness<TParams>;
  readonly skills: SkillController;
  readonly tools: ToolController;
  readonly tasks: TaskController;
  readonly agents: SubagentController;
  readonly channels: ChannelController;
  getSession(scope?: SessionScope): CodeAgentSessionSnapshot;
  dispose(): Promise<void>;
}

//#endregion

//#region Helpers

async function resolvePluginArray<T>(
  value:
    | ReadonlyArray<T>
    | ((ctx: CodeAgentPluginContext) => ReadonlyArray<T> | Promise<ReadonlyArray<T>>)
    | undefined,
  ctx: CodeAgentPluginContext,
): Promise<ReadonlyArray<T>> {
  if (!value) {
    return [];
  }
  if (typeof value === 'function') {
    return value(ctx);
  }
  return value;
}

function createSessionId(): string {
  return `code-agent-${crypto.randomUUID()}`;
}

function resolvePath(base: string, requested: string): string {
  const raw = requested.trim();
  const absolute = raw.startsWith('/') ? raw : `${base}/${raw}`;
  const parts: string[] = [];
  for (const part of absolute.split('/')) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function createSkillsController(skills: ReadonlyArray<CodeAgentSkill>): SkillController {
  const byName = new Map(
    skills.map((skill) => [
      skill.name,
      skill,
    ]),
  );
  return {
    list: () => [
      ...skills,
    ],
    get: (name) => byName.get(name) ?? null,
  };
}

function createToolController(tools: ReadonlyArray<Tool>): ToolController {
  const byName = new Map(
    tools.map((agentTool) => [
      agentTool.name,
      agentTool,
    ]),
  );
  return {
    list: () => [
      ...tools,
    ],
    get: (name) => byName.get(name) ?? null,
  };
}

export function createInMemoryTaskStoreAdapter(): TaskStoreAdapter {
  const tasks = new Map<string, CodeAgentTask>();
  return {
    async list() {
      return [
        ...tasks.values(),
      ];
    },
    async create(input) {
      const now = new Date().toISOString();
      const task: CodeAgentTask = {
        id: `task-${crypto.randomUUID()}`,
        title: input.title,
        body: input.body ?? '',
        status: input.status ?? 'todo',
        createdAt: now,
        updatedAt: now,
      };
      tasks.set(task.id, task);
      return task;
    },
    async update(id, patch) {
      const existing = tasks.get(id);
      if (!existing) {
        throw new Error(`Unknown task: ${id}`);
      }
      const next: CodeAgentTask = {
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      tasks.set(id, next);
      return next;
    },
    async get(id) {
      return tasks.get(id) ?? null;
    },
  };
}

export function createInMemoryPluginStorageAdapter(): (
  scope: PluginStorageScope,
) => StorageAdapter {
  const stores = new Map<PluginStorageScope, StorageAdapter>();
  return (scope) => {
    let store = stores.get(scope);
    if (!store) {
      store = createInMemoryStorage();
      stores.set(scope, store);
    }
    return store;
  };
}

function createTaskController(adapter: TaskStoreAdapter): TaskController {
  return {
    list: () => adapter.list(),
    create: (input) => adapter.create(input),
    update: (id, patch) => adapter.update(id, patch),
    get: (id) => adapter.get(id),
  };
}

export interface CodingToolsPluginOptions {
  readonly read?: boolean;
  readonly write?: boolean;
  readonly list?: boolean;
  readonly shell?: boolean;
}

export function createCodingToolsPlugin(opts: CodingToolsPluginOptions = {}): CodeAgentPlugin {
  const enabled = {
    read: opts.read ?? true,
    write: opts.write ?? true,
    list: opts.list ?? true,
    shell: opts.shell ?? true,
  };

  return {
    name: 'noetic:coding-tools',
    version: '0.1.0',
    tools(ctx) {
      const tools: Tool[] = [];
      if (enabled.read) {
        tools.push(
          tool({
            name: 'Read',
            description: 'Read a UTF-8 text file through the configured filesystem adapter.',
            input: z.object({
              path: z.string().min(1),
            }),
            output: z.object({
              path: z.string(),
              content: z.string(),
            }),
            async execute(args) {
              const path = resolvePath(ctx.cwd, args.path);
              return {
                path,
                content: await ctx.fs.readFileText(path),
              };
            },
          }),
        );
      }
      if (enabled.write) {
        tools.push(
          tool({
            name: 'Write',
            description: 'Write a UTF-8 text file through the configured filesystem adapter.',
            input: z.object({
              path: z.string().min(1),
              content: z.string(),
            }),
            output: z.object({
              path: z.string(),
              bytes: z.number().int().nonnegative(),
            }),
            async execute(args) {
              const path = resolvePath(ctx.cwd, args.path);
              await ctx.fs.writeFile(path, args.content);
              return {
                path,
                bytes: new TextEncoder().encode(args.content).byteLength,
              };
            },
          }),
        );
      }
      if (enabled.list) {
        tools.push(
          tool({
            name: 'List',
            description: 'List directory entries through the configured filesystem adapter.',
            input: z.object({
              path: z.string().min(1).default('.'),
            }),
            output: z.object({
              path: z.string(),
              entries: z.array(z.string()),
            }),
            async execute(args) {
              const path = resolvePath(ctx.cwd, args.path);
              return {
                path,
                entries: await ctx.fs.readdir(path),
              };
            },
          }),
        );
      }
      if (enabled.shell) {
        tools.push(
          tool({
            name: 'Shell',
            description: 'Execute a command through the configured shell adapter.',
            input: z.object({
              command: z.string().min(1),
              cwd: z.string().optional(),
              timeout: z.number().positive().optional(),
              stdin: z.string().optional(),
            }),
            output: z.object({
              stdout: z.string(),
              stderr: z.string(),
              exitCode: z.number().nullable(),
            }),
            async execute(args) {
              return ctx.shell.exec(args.command, {
                cwd: resolvePath(ctx.cwd, args.cwd ?? '.'),
                timeout: args.timeout,
                stdin: args.stdin,
              });
            },
          }),
        );
      }
      return tools;
    },
  };
}

function createSubagentController(): SubagentController {
  const handles: DetachedHandle<unknown>[] = [];
  return {
    list: () => [
      ...handles,
    ],
    track(handle) {
      handles.push(handle);
    },
  };
}

//#region Plan-Act-Verify-Fix Workflow

/**
 * Terminal step: returns the sentinel string that the inner loop's
 * `until.outputEquals` recognizes. The sentinel never enters the item log
 * or assistant text — it exists only to transition the loop to its exit.
 */
const doneStep: Step<ContextMemory, string, string> = step.run({
  id: 'code-agent/done',
  async execute() {
    return CODE_AGENT_DONE_SENTINEL;
  },
});

/**
 * Inner-loop mode routing. Only reached when the outer branch saw a non-plan
 * mode; `plan` is not a valid inner mode. If somehow `mode === 'plan'` leaks
 * (e.g., via a revise outcome that the outer branch already handled), fall
 * through to act as a conservative default.
 */
const INNER_MODE_ROUTES: Record<
  'act' | 'verify' | 'fix' | 'done',
  Step<ContextMemory, string, string>
> = {
  act: actAgent,
  verify: verifyAndCheck,
  fix: fixAgent,
  done: doneStep,
};

/**
 * The act/verify/fix inner loop. Exits when `doneStep` emits the sentinel.
 * Termination is driven by the state machine itself — `verifyCheckStep`
 * enforces the fix-loop attempt cap and findings-hash divergence check,
 * so no explicit iteration cap is needed here. The loop builder's default
 * safety ceiling (1000) remains as the ultimate backstop.
 */
const actVerifyFixLoop: Step<ContextMemory, string, string> = loop({
  id: 'code-agent/act-verify-fix-loop',
  steps: [
    branch({
      id: 'code-agent/inner-dispatch',
      route: (_input, ctx) => {
        const mode = readFlowState(ctx).mode ?? 'act';
        if (mode === 'plan') {
          return actAgent;
        }
        return INNER_MODE_ROUTES[mode];
      },
      _optimizable: frameworkCast<Step<ContextMemory>[]>([
        actAgent,
        verifyAndCheck,
        fixAgent,
        doneStep,
      ]),
    }),
  ],
  until: until.outputEquals(CODE_AGENT_DONE_SENTINEL),
});

/**
 * Wrapper that intercepts the sentinel and substitutes the accumulated
 * `lastUserText`. Ensures `HarnessResponse.text` never contains the sentinel
 * string and always reflects the most recent user-relevant output.
 */
/**
 * Fallback surfaced to the user when the workflow completes but no
 * mode-transition step recorded a meaningful `lastUserText`. Prefer a short,
 * non-empty acknowledgment over an empty assistant message — an empty
 * `HarnessResponse.text` reads as a silent failure in most UIs.
 */
const EMPTY_RESULT_FALLBACK = 'Done.';

const actVerifyFixWrapper: Step<ContextMemory, string, string> = step.run({
  id: 'code-agent/act-verify-fix-wrapper',
  async execute(input, ctx) {
    const result = await ctx.harness.run(actVerifyFixLoop, input, ctx);
    if (result === CODE_AGENT_DONE_SENTINEL) {
      const state = readFlowState(ctx);
      const text = state.lastUserText ?? '';
      return text.trim().length > 0 ? text : EMPTY_RESULT_FALLBACK;
    }
    return result;
  },
});

/**
 * The top-level workflow. A single branch dispatches to the plan path (single-
 * turn) or the act/verify/fix wrapper (inner multi-mode loop). Mode routing
 * happens via memory state, not LLM output, so every transition is
 * deterministic. `verifyAgent` is included in `_optimizable` so
 * `collectAllTools` walks into its tool set even though it's routed to via
 * `verifyAndCheck`.
 */
export const codeAgentWorkflow: Step<ContextMemory, string, string> = branch({
  id: 'code-agent/mode-dispatch',
  route: (_input, ctx) => {
    const mode = readFlowState(ctx).mode ?? 'plan';
    return mode === 'plan' ? planAgent : actVerifyFixWrapper;
  },
  _optimizable: frameworkCast<Step<ContextMemory>[]>([
    planAgent,
    actAgent,
    verifyAgent,
    fixAgent,
    doneStep,
  ]),
});

//#endregion
//#endregion

//#region CodeAgentImpl

class CodeAgentImpl<TParams extends Record<string, unknown>> implements CodeAgent<TParams> {
  readonly kind = 'code-agent' as const;

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    readonly harness: AgentHarness<TParams>,
    readonly skills: SkillController,
    readonly tools: ToolController,
    readonly tasks: TaskController,
    readonly agents: SubagentController,
    readonly channels: ChannelController,
    private readonly plugins: ReadonlyArray<CodeAgentPlugin>,
    private readonly disposeChannels: () => Promise<void>,
  ) {}

  get config(): AgentConfig<TParams> {
    return this.harness.config;
  }

  get fs(): FsAdapter {
    return this.harness.fs;
  }

  get shell(): ShellAdapter {
    return this.harness.shell;
  }

  get subprocess(): SubprocessAdapter {
    return this.harness.subprocess;
  }

  get rootCwdState(): CwdState {
    return this.harness.rootCwdState;
  }

  callModel(request: CallModelRequest): Promise<LLMResponse> {
    return this.harness.callModel(request);
  }

  execute(input: ExecuteInput, options?: ExecuteOptions): Promise<void> {
    return this.harness.execute(input, options);
  }

  getAgentResponse(scope?: SessionScope): Promise<HarnessResponse> {
    return this.harness.getAgentResponse(scope);
  }

  getItemStream(scope?: SessionScope): AsyncIterable<StreamingItem> {
    return this.harness.getItemStream(scope);
  }

  getTextStream(scope?: SessionScope): AsyncIterable<string> {
    return this.harness.getTextStream(scope);
  }

  getReasoningStream(scope?: SessionScope): AsyncIterable<string> {
    return this.harness.getReasoningStream(scope);
  }

  getFullStream(scope?: SessionScope): AsyncIterable<StreamEvent> {
    return this.harness.getFullStream(scope);
  }

  abort(
    scope?: SessionScope & {
      reason?: string;
    },
  ): Promise<void> {
    return this.harness.abort(scope);
  }

  getStatus(scope?: SessionScope): HarnessStatus {
    return this.harness.getStatus(scope);
  }

  getQueueSize(scope?: SessionScope): number {
    return this.harness.getQueueSize(scope);
  }

  seedSessionHistory(threadId: string, items: ReadonlyArray<Item>): void {
    this.harness.seedSessionHistory(threadId, items);
  }

  run<I, O>(agentStep: Step<ContextMemory, I, O>, input: I, ctx: Context): Promise<O> {
    return this.harness.run(agentStep, input, ctx);
  }

  detachedSpawn<I, O>(
    agentStep: Step<ContextMemory, I, O>,
    input: I,
    parentCtx: Context,
    overrides?: {
      threadId?: string;
      resourceId?: string;
      cwdInit?: string;
    },
  ): DetachedHandle<O> {
    const handle = this.harness.detachedSpawn(agentStep, input, parentCtx, overrides);
    this.agents.track(handle);
    return handle;
  }

  createContext(opts?: {
    parent?: Context;
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
    memory?: MemoryLayer[];
    cwdInit?: string;
  }): Context {
    return this.harness.createContext(opts);
  }

  setRootCwd(nextCwd: string): void {
    this.harness.setRootCwd(nextCwd);
  }

  send<T>(channel: Channel<T>, value: T, ctx: Context): void {
    void this.channels.publish(channel, value, ctx);
  }

  recv<T>(
    channel: Channel<T>,
    ctx: Context,
    opts?: {
      timeout?: number;
    },
  ): Promise<T> {
    return this.harness.recv(channel, ctx, opts);
  }

  tryRecv<T>(channel: Channel<T>, ctx: Context): T | null {
    return this.harness.tryRecv(channel, ctx);
  }

  getChannelHandle<T>(channel: ExternalChannel<T>, executionId: string): ChannelHandle<T> {
    return this.harness.getChannelHandle(channel, executionId);
  }

  initLayers(layers: MemoryLayer[], ctx: Context, storage: StorageAdapter): Promise<void> {
    return this.harness.initLayers(layers, ctx, storage);
  }

  recallLayers(layers: MemoryLayer[], input: string, ctx: Context): Promise<RecallLayerOutput[]> {
    return this.harness.recallLayers(layers, input, ctx);
  }

  previewRequestItems(scope?: SessionScope): Promise<ReadonlyArray<Item>> {
    return this.harness.previewRequestItems(scope);
  }

  storeLayers(layers: MemoryLayer[], response: LLMResponse, ctx: Context): Promise<void> {
    return this.harness.storeLayers(layers, response, ctx);
  }

  disposeLayers(layers: MemoryLayer[], ctx: Context): Promise<void> {
    return this.harness.disposeLayers(layers, ctx);
  }

  checkpoint(ctx: Context): Promise<void> {
    return this.harness.checkpoint(ctx);
  }

  restore(executionId: string): Promise<Context | null> {
    return this.harness.restore(executionId);
  }

  cancel(ctx: Context, reason?: string): Promise<void> {
    return this.harness.cancel(ctx, reason);
  }

  createSpan(name: string, parent: Span | null): Span {
    return this.harness.createSpan(name, parent);
  }

  getLayerState<T>(executionId: string, layerId: string): T | undefined {
    return this.harness.getLayerState(executionId, layerId);
  }

  setLayerState<T>(executionId: string, layerId: string, state: T): void {
    this.harness.setLayerState(executionId, layerId, state);
  }

  beforeToolCall(
    layers: MemoryLayer[],
    toolName: string,
    toolArgs: unknown,
    ctx: Context,
  ): Promise<SteeringDecision> {
    return this.harness.beforeToolCall(layers, toolName, toolArgs, ctx);
  }

  afterModelCall(
    layers: MemoryLayer[],
    response: LLMResponse,
    ctx: Context,
  ): Promise<SteeringDecision> {
    return this.harness.afterModelCall(layers, response, ctx);
  }

  projectHistory(
    layers: MemoryLayer[],
    items: ReadonlyArray<Item>,
    ctx: Context,
  ): Promise<ReadonlyArray<Item>> {
    return this.harness.projectHistory(layers, items, ctx);
  }

  runAppendPipeline(
    layers: MemoryLayer[],
    items: Item[],
    ctx: Context,
  ): ReturnType<AgentHarness<TParams>['runAppendPipeline']> {
    return this.harness.runAppendPipeline(layers, items, ctx);
  }

  executeRerender(
    requests: Parameters<AgentHarness<TParams>['executeRerender']>[0],
    layers: MemoryLayer[],
    ctx: Context,
    budgets: Map<string, number>,
    query?: string,
  ): Promise<RecallLayerOutput[]> {
    return this.harness.executeRerender(requests, layers, ctx, budgets, query);
  }

  getSession(scope?: SessionScope): CodeAgentSessionSnapshot {
    return {
      id: scope?.threadId ?? this.sessionId,
      cwd: this.rootCwdState.cwd,
      status: this.getStatus(scope),
      queueSize: this.getQueueSize(scope),
    };
  }

  async dispose(): Promise<void> {
    for (const plugin of [
      ...this.plugins,
    ].reverse()) {
      await plugin.dispose?.();
    }
    await this.disposeChannels();
  }
}

//#endregion

//#region Public API

export async function createCodeAgent(
  options: CreateCodeAgentOptions,
): Promise<CodeAgent<CodeAgentParams>> {
  const cwd = options.cwd ?? '/';
  const fs = options.adapters?.fs ?? createInMemoryFsAdapter();
  const shell = options.adapters?.shell ?? createInMemoryShellAdapter();
  const sessionId = createSessionId();

  let harness: AgentHarness<CodeAgentParams>;
  let channelController: ChannelController;
  const channelTransport = options.adapters?.channels ?? createInMemoryChannelTransportAdapter();
  const defaultPluginStorage = createInMemoryPluginStorageAdapter();
  const channelSchemas = new Map<string, Channel<unknown>>();
  const inboundSubscribers = new Map<string, Set<(value: unknown) => void>>();
  const locallyPublishedFrames = new WeakSet<ChannelTransportFrame>();
  let channelBridgeCtx: Context | null = null;

  function registerChannel(channel: Channel<unknown>): void {
    channelSchemas.set(channel.name, channel);
  }

  const transportController: ChannelTransportController = {
    receive(frame) {
      const channel = channelSchemas.get(frame.channel);
      if (!channel) {
        console.warn(`[noetic/code-agent] Dropping frame for unknown channel '${frame.channel}'.`);
        return;
      }
      const parsed = channel.schema.safeParse(frame.value);
      if (!parsed.success) {
        console.warn(`[noetic/code-agent] Dropping invalid frame for channel '${frame.channel}'.`);
        return;
      }
      if (locallyPublishedFrames.has(frame)) {
        locallyPublishedFrames.delete(frame);
        return;
      }
      if (channelBridgeCtx) {
        harness.send(channel, parsed.data, channelBridgeCtx);
      }
      for (const handler of inboundSubscribers.get(frame.channel) ?? []) {
        handler(parsed.data);
      }
    },
  };

  const pluginCtx = (pluginName: string): CodeAgentPluginContext => ({
    cwd,
    model: options.model,
    fs,
    shell,
    channels: channelController,
    tasks: taskController,
    pluginStorage: (scope) =>
      options.adapters?.pluginStorage?.(pluginName, scope) ?? defaultPluginStorage(scope),
  });

  const taskController = createTaskController(
    options.adapters?.tasks ?? createInMemoryTaskStoreAdapter(),
  );
  const subagents = createSubagentController();
  const pluginTools: Tool[] = [];
  const pluginMemory: MemoryLayer[] = [];
  const pluginSkills: CodeAgentSkill[] = [];

  channelController = {
    async publish(channel, value, ctx) {
      registerChannel(channel);
      if (ctx) {
        harness.send(channel, value, ctx);
      }
      const frame = {
        channel: channel.name,
        value: channel.schema.parse(value),
      };
      locallyPublishedFrames.add(frame);
      await channelTransport.publish(frame);
    },
    subscribe(channel, handler) {
      registerChannel(channel);
      let subscribers = inboundSubscribers.get(channel.name);
      if (!subscribers) {
        subscribers = new Set();
        inboundSubscribers.set(channel.name, subscribers);
      }
      const wrapped = (value: unknown): void => handler(channel.schema.parse(value));
      subscribers.add(wrapped);
      return () => subscribers?.delete(wrapped);
    },
    recv(channel, ctx, opts) {
      registerChannel(channel);
      return harness.recv(channel, ctx, opts);
    },
    tryRecv(channel, ctx) {
      registerChannel(channel);
      return harness.tryRecv(channel, ctx);
    },
    getHandle(channel, executionId) {
      registerChannel(channel);
      return harness.getChannelHandle(channel, executionId);
    },
  };

  for (const plugin of options.plugins ?? []) {
    const ctx = pluginCtx(plugin.name);
    await plugin.initialize?.(ctx);
    pluginTools.push(...(await resolvePluginArray(plugin.tools, ctx)));
    pluginMemory.push(...(await resolvePluginArray(plugin.memoryLayers, ctx)));
    pluginSkills.push(...(await resolvePluginArray(plugin.skills, ctx)));
  }

  const tools = [
    ...(options.tools ?? []),
    ...pluginTools,
  ];
  const memory =
    options.defaultMemory === false
      ? [
          flowMemory,
          ...(options.memory ?? []),
          ...pluginMemory,
        ]
      : [
          flowMemory,
          planMemory(),
          workingMemory(),
          observationalMemory(),
          durableTaskState(),
          ...toolMemoryLayer(tools),
          ...(options.memory ?? []),
          ...pluginMemory,
          historyWindow({
            maxItems: 400,
          }),
        ];

  harness = new AgentHarness<CodeAgentParams>({
    name: options.name ?? 'noetic-code-agent',
    params: {
      model: options.model,
      instructions: options.instructions,
      verifyThreshold: options.verifyThreshold,
      maxFixAttempts: options.maxFixAttempts,
    },
    hooks: options.hooks,
    storage: options.adapters?.storage,
    fs,
    shell,
    subprocess: options.adapters?.subprocess,
    initialCwd: cwd,
    initialStep: codeAgentWorkflow,
    tools,
    memory,
    llm: options.llm,
    itemSchemas: options.itemSchemas,
    strictItemSchemas: options.strictItemSchemas,
    traceExporter: options.traceExporter,
    defaultDeliveryMode: options.defaultDeliveryMode,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    _testCallModel: options.modelAdapter
      ? (request) => options.modelAdapter!.callModel(request)
      : undefined,
  });
  channelBridgeCtx = harness.createContext({
    threadId: `${sessionId}:channels`,
  });
  channelTransport.subscribe?.((frame) => transportController.receive(frame));
  await channelTransport.start?.(transportController);

  return new CodeAgentImpl(
    sessionId,
    cwd,
    harness,
    createSkillsController(pluginSkills),
    createToolController(tools),
    taskController,
    subagents,
    channelController,
    options.plugins ?? [],
    async () => {
      await channelTransport.stop?.();
    },
  );
}

export {
  createInMemoryFsAdapter,
  createInMemoryShellAdapter,
} from '@noetic/core/portable';
export {
  type ChannelTransportAdapter,
  type ChannelTransportController,
  type ChannelTransportFrame,
  createInMemoryChannelTransportAdapter,
} from './channels.js';

export { createTaskToolsPlugin } from './tasks/plugin.js';

//#endregion
