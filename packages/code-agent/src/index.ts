import type {
  AgentConfig,
  AgentHarnessContract,
  AgentHooks,
  AskUserInput,
  AskUserOutput,
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
  AskUserOutputSchema,
  branch,
  createInMemoryFsAdapter,
  createInMemoryShellAdapter,
  createInMemoryStorage,
  durableTaskState,
  historyWindow,
  layerData,
  loop,
  observationalMemory,
  planMemory,
  Slot,
  spawn,
  step,
  tool,
  toolMemoryLayer,
  until,
  workingMemory,
} from '@noetic/core/portable';
import { frameworkCast } from '@noetic/core/unstable';
import { z } from 'zod';
import type {
  ChannelTransportAdapter,
  ChannelTransportController,
  ChannelTransportFrame,
} from './channels.js';
import { createInMemoryChannelTransportAdapter } from './channels.js';
import type { AskUserTool } from './tools/ask-user.js';

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
}

export type CodeAgentMode = 'plan' | 'act';

export interface CodeAgentPlanApprovalQuestion {
  question: string;
  header: string;
}

export interface CodeAgentFlowState {
  mode?: CodeAgentMode;
  awaitingPlanApproval?: boolean;
  approvalQuestion?: CodeAgentPlanApprovalQuestion;
}

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

//#region Plan-Act Flow

/** Maximum iterations for the plan and act sub-loops. */
const PLAN_ACT_MAX_ITERATIONS = 20;

/** Layer id for the code-agent plan/act mode memory layer. */
const CODE_AGENT_FLOW_LAYER_ID = 'code-agent-flow';

/** Name of the built-in AskUserQuestion tool (registered when an AskUserService is configured). */
const ASK_USER_TOOL_NAME = 'AskUserQuestion';

/** Label prefix used for the approve option; `answerLooksApproved` matches case-insensitive. */
const APPROVE_OPTION_LABEL = 'Approve (Recommended)';
const REVISE_OPTION_LABEL = 'Revise';

/**
 * Tool names the plan agent is permitted to call. Restricted to read-only
 * exploration, user interaction, sub-agent orchestration, and the approval
 * tool. Excludes Write / Edit / Bash and anything else that mutates the
 * filesystem or shell state before the plan is approved.
 */
const PLAN_MODE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Find',
  'Ls',
  'AskUserQuestion',
  'activateSkill',
  'agent',
  'sendMessage',
  'checkAgent',
]);

/** Hard ceiling on approval-question length so the tool args survive validation. */
const DEFAULT_APPROVAL_QUESTION = 'Approve this plan and switch to act mode?';
const DEFAULT_APPROVAL_HEADER = 'Approve';

/** Zod schema for workflow state, used at the ctx.memory read boundary (issue #2). */
const CodeAgentFlowStateSchema: z.ZodType<CodeAgentFlowState> = z.object({
  mode: z
    .enum([
      'plan',
      'act',
    ])
    .optional(),
  awaitingPlanApproval: z.boolean().optional(),
  approvalQuestion: z
    .object({
      question: z.string(),
      header: z.string(),
    })
    .optional(),
});

const RequestPlanApprovalInputSchema = z.object({
  question: z.string().min(1).default(DEFAULT_APPROVAL_QUESTION),
  header: z.string().min(1).max(12).default(DEFAULT_APPROVAL_HEADER),
});

const RequestPlanApprovalOutputSchema = z.object({
  awaitingApproval: z.boolean(),
  question: z.string(),
});

function answerLooksApproved(value: string): boolean {
  return value.toLowerCase().startsWith('approve');
}

/**
 * Typed, defensive read of the workflow state from `ctx.memory`. The layer
 * exposes `provides.state` as a `layerData` projection; parsing via
 * `CodeAgentFlowStateSchema` keeps the call site type-safe without reaching
 * into `ctx.harness.getLayerState` or casting the opaque memory handle.
 */
function readFlowState(ctx: Context<ContextMemory>): CodeAgentFlowState {
  const handle = ctx.memory[CODE_AGENT_FLOW_LAYER_ID];
  const raw = handle?.state;
  const parsed = CodeAgentFlowStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/**
 * Typed write that updates the workflow state via `ctx.harness.setLayerState`
 * — the sanctioned runtime API for step-level state writes (see spec 11).
 * Tools use `toolCtx.memory.set(...)` (see `createPlanApprovalTool`).
 */
function writeFlowState(ctx: Context<ContextMemory>, state: CodeAgentFlowState): void {
  ctx.harness.setLayerState<CodeAgentFlowState>(ctx.id, CODE_AGENT_FLOW_LAYER_ID, state);
}

/**
 * Tool via which the plan-mode LLM signals that it wants user approval. The
 * tool mutates memory through the typed `toolCtx.memory.set` helper (the
 * `ToolMemory` API from `@noetic/core`) rather than reaching into
 * `ctx.harness.setLayerState` through a cast.
 */
function createPlanApprovalTool(): Tool {
  return tool({
    name: 'requestPlanApproval',
    description:
      'Request user approval for the current implementation plan. This marks the workflow as awaiting approval; the workflow asks the user and switches to act mode only after approval.',
    input: RequestPlanApprovalInputSchema,
    output: RequestPlanApprovalOutputSchema,
    async execute(input, toolCtx) {
      const existing = toolCtx.memory.get<CodeAgentFlowState>(CODE_AGENT_FLOW_LAYER_ID) ?? {};
      toolCtx.memory.set<CodeAgentFlowState>(CODE_AGENT_FLOW_LAYER_ID, {
        ...existing,
        mode: 'plan',
        awaitingPlanApproval: true,
        approvalQuestion: {
          question: input.question,
          header: input.header,
        },
      });
      return {
        awaitingApproval: true,
        question: input.question,
      };
    },
  });
}

/**
 * Memory layer tracking the top-level plan/act mode and any outstanding plan
 * approval request. `provides.state` exposes a typed read projection on
 * `ctx.memory['code-agent-flow'].state` (data-kind provides are not surfaced
 * to the LLM as tools — see layer-api's `resolveLayerTools`).
 */
function createCodeAgentFlowMemory(): MemoryLayer<CodeAgentFlowState> {
  return {
    id: CODE_AGENT_FLOW_LAYER_ID,
    name: 'Code Agent Flow',
    // The mode advisory sits just above the steering slot so it is recalled
    // as steering context (ahead of working memory / observations) without
    // fighting built-in steering layers for the same slot.
    slot: Slot.STEERING + 5,
    scope: 'thread',
    provides: {
      state: layerData<CodeAgentFlowState, CodeAgentFlowState>({
        read: (state) => state,
      }),
    },
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<CodeAgentFlowState>('state');
        return {
          state: saved ?? {
            mode: 'plan',
          },
        };
      },
      async recall({ state }) {
        const mode = state.mode === 'act' ? 'act' : 'plan';
        const waiting = state.awaitingPlanApproval === true ? '\nAwaiting plan approval.' : '';
        return `<code_agent_flow mode="${mode}">${waiting}</code_agent_flow>`;
      },
      async store({ state }) {
        return {
          state,
        };
      },
      async onSpawn({ parentState }) {
        return {
          childState: {
            ...parentState,
          },
        };
      },
      async onReturn({ childState, parentState }) {
        // Propagate only the three known flow fields, and only when the child
        // actually set them. Spawned plan agents need to flip mode plan → act
        // after approval, so the child's assignment wins when defined — but an
        // exploration teammate that never touched the flow state shouldn't
        // erase anything the parent set in the meantime.
        return {
          parentState: {
            ...parentState,
            ...(childState.mode !== undefined && {
              mode: childState.mode,
            }),
            ...(childState.awaitingPlanApproval !== undefined && {
              awaitingPlanApproval: childState.awaitingPlanApproval,
            }),
            ...(childState.approvalQuestion !== undefined && {
              approvalQuestion: childState.approvalQuestion,
            }),
          },
        };
      },
    },
  };
}

/**
 * Builds the AskUserQuestion tool input for the plan-approval prompt. Sourced
 * from the flow state so the question text matches exactly what the LLM
 * requested via `requestPlanApproval` — no string-comparison against a
 * hard-coded prompt elsewhere in the file (issue #1, #3).
 */
function buildApprovalAskInput(state: CodeAgentFlowState, previousPlanText: string): AskUserInput {
  const question = state.approvalQuestion?.question ?? DEFAULT_APPROVAL_QUESTION;
  const header = state.approvalQuestion?.header ?? DEFAULT_APPROVAL_HEADER;
  const trimmed = previousPlanText.trim();
  const preview = trimmed.length > 0 ? trimmed : undefined;
  return {
    questions: [
      {
        question,
        header,
        options: [
          {
            label: APPROVE_OPTION_LABEL,
            description:
              'The workflow records act mode and the act agent can start implementation.',
            ...(preview
              ? {
                  preview,
                }
              : {}),
          },
          {
            label: REVISE_OPTION_LABEL,
            description:
              'The workflow stays in plan mode so the plan agent can revise the approach.',
          },
        ],
        multiSelect: false,
      },
    ],
  };
}

/**
 * Extracts the first (and, by construction, only) answer from the AskUser
 * output. Looking up by position avoids coupling the approval record to the
 * exact question text (issue #3) — `buildApprovalAskInput` emits one
 * question, so `answers` has exactly one entry.
 */
function extractApprovalAnswer(output: AskUserOutput): string {
  const first = Object.values(output.answers)[0];
  return typeof first === 'string' ? first : '';
}

interface PlanApprovalStepArgs {
  planLoopId: string;
  askUserTool: AskUserTool | undefined;
  flowMemory: MemoryLayer<CodeAgentFlowState>;
}

/** Empty LLMResponse used to trigger a `storeLayers` pass solely to persist
 *  the flow-state mutation. The store hook reads from layer state, not from
 *  this response, so the empty shape is inert. */
const EMPTY_STORE_RESPONSE: LLMResponse = {
  items: [],
  usage: {
    inputTokens: 0,
    outputTokens: 0,
  },
};

/**
 * Flushes the current in-memory flow state to durable storage via the layer's
 * store hook. Required after the approval step mutates state — the plan LLM's
 * own `storeLayers` pass already ran with the pre-approval snapshot, so the
 * post-approval mutation would otherwise be lost on the next turn's rehydrate.
 */
async function persistFlowState(
  ctx: Context<ContextMemory>,
  flowMemory: MemoryLayer<CodeAgentFlowState>,
): Promise<void> {
  await ctx.harness.storeLayers(
    [
      flowMemory,
    ],
    EMPTY_STORE_RESPONSE,
    ctx,
  );
}

/**
 * Narrows a generic `Tool` to `AskUserTool` by checking its registered name.
 * Identity check is sufficient — `AskUserQuestion` is the stable, framework-
 * level identifier for the ask-user tool and the only tool registered under
 * that name.
 */
function isAskUserTool(t: Tool): t is AskUserTool {
  return t.name === ASK_USER_TOOL_NAME;
}

function getAskUserTool(tools: ReadonlyArray<Tool>): AskUserTool | undefined {
  return tools.find(isAskUserTool);
}

/**
 * The "approval dispatch" step that runs after the plan LLM turn. When the
 * LLM called `requestPlanApproval`, this step fires the pre-built
 * `step.tool(askUser)` with dynamic args via `ctx.harness.run`, then updates
 * memory based on the user's answer.
 *
 * A pure step-composition expression (step.tool as a direct sibling in the
 * loop's `steps` array) isn't viable here because the loop body must be
 * `Step<string, string>` while `step.tool(askUser)` is
 * `Step<AskUserInput, AskUserOutput>`. `ctx.harness.run` is the typed,
 * public adapter for dispatching a step with a different I/O signature.
 * The askUser tool is still visible to the tool collector via the plan
 * LLM's `tools` array (see `collectAllTools` in core) — this step is only
 * the composition-level hand-off.
 */
function createPlanApprovalStep(args: PlanApprovalStepArgs): Step<ContextMemory, string, string> {
  const askUserStep = args.askUserTool
    ? step.tool<ContextMemory, AskUserInput, AskUserOutput>({
        id: `${args.planLoopId}-ask`,
        tool: args.askUserTool,
      })
    : null;
  return step.run<ContextMemory, string, string>({
    id: `${args.planLoopId}-approval`,
    async execute(input, ctx) {
      const state = readFlowState(ctx);
      if (state.awaitingPlanApproval !== true) {
        return input;
      }
      if (!askUserStep) {
        // Fail-open: no interactive approval service available — auto-approve
        // and advance to act mode. Leaving mode=plan here would strand the
        // workflow (issue #4).
        writeFlowState(ctx, {
          ...state,
          mode: 'act',
          awaitingPlanApproval: false,
          approvalQuestion: undefined,
        });
        await persistFlowState(ctx, args.flowMemory);
        return 'Plan approved automatically (no interactive approval service available). Act mode is now active.';
      }
      const askInput = buildApprovalAskInput(state, input);
      const rawResult = await ctx.harness.run(askUserStep, askInput, ctx);
      const result = AskUserOutputSchema.parse(rawResult);
      const approved = answerLooksApproved(extractApprovalAnswer(result));
      writeFlowState(ctx, {
        ...state,
        mode: approved ? 'act' : 'plan',
        awaitingPlanApproval: false,
        approvalQuestion: undefined,
      });
      await persistFlowState(ctx, args.flowMemory);
      return approved
        ? 'Plan approved. Act mode is now active.'
        : 'Plan approval was not granted. Stay in plan mode and revise the plan.';
    },
  });
}

interface BuildSubAgentArgs {
  id: string;
  model: string;
  instructions: string[];
  tools: ReadonlyArray<Tool>;
  bodyExtraSteps?: ReadonlyArray<Step<ContextMemory, string, string>>;
}

function buildSubAgent(args: BuildSubAgentArgs): Step<ContextMemory, string, string> {
  const chatId = `${args.id}-chat`;
  const loopId = `${args.id}-loop`;
  const extraSteps = args.bodyExtraSteps ?? [];
  const innerLoop = loop<ContextMemory, string, string>({
    id: loopId,
    steps: [
      step.llm<ContextMemory, string, string>({
        id: chatId,
        model: args.model,
        instructions: args.instructions.filter(Boolean).join('\n\n'),
        tools: [
          ...args.tools,
        ],
      }),
      ...extraSteps,
    ],
    until: until.noToolCalls(),
    maxIterations: PLAN_ACT_MAX_ITERATIONS,
  });
  return spawn<ContextMemory, string, string>({
    id: args.id,
    child: innerLoop,
  });
}

function createCodeAgentWorkflow(args: {
  model: string;
  instructions?: string;
  planTools: ReadonlyArray<Tool>;
  actTools: ReadonlyArray<Tool>;
  flowMemory: MemoryLayer<CodeAgentFlowState>;
}): Step<ContextMemory, string, string> {
  const suffix = crypto.randomUUID();
  const planAgentId = `noetic-code-agent-plan-agent-${suffix}`;
  const actAgentId = `noetic-code-agent-act-agent-${suffix}`;
  const askUserTool = getAskUserTool(args.planTools);
  // Headless mode (no AskUserQuestion registered): skip registering
  // `requestPlanApproval` entirely. The plan LLM has no way to request
  // approval from a user that can't respond, and registering the tool
  // would leave `awaitingPlanApproval: true` half-set across turns.
  const planTools: ReadonlyArray<Tool> = askUserTool
    ? [
        ...args.planTools,
        createPlanApprovalTool(),
      ]
    : [
        ...args.planTools,
      ];

  const planLoopId = `noetic-code-agent-plan-agent-${suffix}-loop`;
  const approvalStep = createPlanApprovalStep({
    planLoopId,
    askUserTool,
    flowMemory: args.flowMemory,
  });
  const planInstructions = [
    args.instructions,
    'You are the top-level plan agent. Stay in plan mode until the user approves the plan. Use read-only tools, AskUserQuestion for requirement choices, and sub-agents for bounded exploration or planning work. When the plan is ready, call requestPlanApproval; the workflow will ask the user and switch to act mode only after approval.',
  ].filter((line): line is string => Boolean(line));
  const planAgent = buildSubAgent({
    id: planAgentId,
    model: args.model,
    instructions: planInstructions,
    tools: planTools,
    bodyExtraSteps: [
      approvalStep,
    ],
  });

  const actInstructions = [
    args.instructions,
    'You are the top-level act agent. Implement the approved plan, use sub-agents for bounded parallel work when useful, and verify changes before reporting completion.',
  ].filter((line): line is string => Boolean(line));
  const actAgent = buildSubAgent({
    id: actAgentId,
    model: args.model,
    instructions: actInstructions,
    tools: args.actTools,
  });

  // Top-level dispatcher: a per-turn branch on the current mode. The
  // containing harness invokes this step once per user message, so there is
  // no outer loop — each sub-agent does its own LLM looping until
  // `noToolCalls`. `_optimizable` carries the concrete branches so
  // `collectAllTools` can walk into them when building the unified tool set.
  return branch<ContextMemory, string, string>({
    id: `noetic-code-agent-mode-branch-${suffix}`,
    route: (_input, ctx) => (readFlowState(ctx).mode === 'act' ? actAgent : planAgent),
    // `_optimizable` is typed `Step<TMemory>[]` (I=O=unknown) for structural
    // traversal by `collectAllTools` (see packages/core/src/interpreter/
    // collect-tools.ts). The array is iterated, never invoked, so the widening
    // is sound. `frameworkCast` isolates this single coercion per
    // `.claude/rules/type-safety.md`.
    _optimizable: frameworkCast<Step<ContextMemory>[]>([
      planAgent,
      actAgent,
    ]),
  });
}

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
  const planTools = tools.filter((t) => PLAN_MODE_TOOL_NAMES.has(t.name));
  const flowMemory = createCodeAgentFlowMemory();
  const initialStep = createCodeAgentWorkflow({
    model: options.model,
    instructions: options.instructions,
    planTools,
    actTools: tools,
    flowMemory,
  });
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
    },
    hooks: options.hooks,
    storage: options.adapters?.storage,
    fs,
    shell,
    subprocess: options.adapters?.subprocess,
    initialCwd: cwd,
    initialStep,
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
