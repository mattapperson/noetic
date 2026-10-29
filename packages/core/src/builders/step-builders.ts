import type { ContextData } from '@noetic-tools/context';
import type {
  AcpAgent,
  AcpClientCapabilityConfig,
  AcpContentBlock,
  AcpMcpServer,
  AcpPermissionHandler,
  AcpPermissionPolicy,
  AcpSessionPolicy,
  AnyProfile,
  ConnectionEvent,
  ConnectionHandle,
  Context,
  CustomItemMap,
  CustomItemsBrand,
  Lazy,
  ModelParams,
  OperationInput,
  OperationName,
  OperationOutput,
  OutputCodec,
  RetryPolicy,
  RunCodeExecute,
  ServerToolSpec,
  StandardSchemaV1,
  Step,
  StepAcpAgent,
  StepCall,
  StepCallModel,
  StepEmitItems,
  StepInvokeTool,
  StepReplay,
  StepRunCode,
  StepWait,
  StepWaitOutput,
  SubprocessAdapter,
  Tool,
  ToolChoice,
} from '@noetic-tools/types';
import { frameworkCast, isServerToolSpec, NoeticConfigError } from '@noetic-tools/types';
import { getDefaultRegistrar } from '../types/step-registrar';
import { checkEmitItems, isGeneratorFunction } from './custom-item';
import { verify } from './verify-builder';

//#region Types

export interface RunCodeOpts<TContext, I, O, M extends CustomItemMap = CustomItemMap>
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O, M> {
  id: string;
  /** Async, or a generator whose yields are events of the item `emitItems` names. */
  execute: RunCodeExecute<TContext, I, O>;
  retry?: RetryPolicy;
  /**
   * Optional subprocess adapter override. When set, `execute()` is routed
   * through this adapter instead of the harness default. See spec 04 for
   * precedence rules.
   */
  subprocess?: SubprocessAdapter;
}

export interface CallModelOpts<TContext, O, I = unknown>
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
  id: string;
  /** Model id. Eager string or `(ctx) => string` getter (resolved at step execution). */
  model: Lazy<string, TContext>;
  /** Optional instructions; eager string or `(ctx) => string | undefined` getter. */
  instructions?: Lazy<string | undefined, TContext>;
  /**
   * Optional tools; eager array or `(ctx) => (...)[] | undefined` getter. Each
   * entry is either a client `Tool` or an inline `ServerToolSpec` (an OpenRouter
   * server tool the provider executes, e.g. web search/fetch).
   */
  tools?: Lazy<(Tool | ServerToolSpec)[] | undefined, TContext>;
  /**
   * How the model may use its tools: `'auto'` (default), `'required'`,
   * `'none'`, or `{ tool: name }` to force one client tool from `tools`.
   */
  toolChoice?: ToolChoice;
  /** Structured output: a Standard Schema (Zod, Valibot, …) or a streaming `OutputCodec` (e.g. OpenUI Lang). */
  output?: StandardSchemaV1<unknown, O> | OutputCodec<O>;
  /**
   * Explicit raw JSON Schema override sent to the model. For non-Zod schemas,
   * it takes precedence over StandardJSONSchemaV1 conversion.
   */
  outputJsonSchema?: Record<string, unknown>;
  params?: ModelParams;
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
}

export interface InvokeToolOpts<I, O, TContext = ContextData>
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
  id: string;
  tool: Tool<StandardSchemaV1<unknown, I>, StandardSchemaV1<unknown, O>>;
  args?: Partial<I>;
}

export interface StepAcpAgentOpts<TContext, O, I = unknown>
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
  id: string;
  /** An ACP agent adapter, e.g. `claudeCode()` from `@noetic-tools/acp`. Eager or `(ctx) => AcpAgent`. */
  agent: Lazy<AcpAgent, TContext>;
  /** Turn prompt as plain text. Eager string or `(ctx) => string` getter. */
  prompt?: Lazy<string, TContext>;
  /**
   * Full ACP prompt content — images, audio, resource links, embedded context.
   * Appended after `prompt`. Rejected before the turn is sent when the agent
   * did not advertise the matching prompt capability.
   */
  content?: Lazy<ReadonlyArray<AcpContentBlock> | undefined, TContext>;
  /** MCP servers to expose to the agent for this session. */
  mcpServers?: Lazy<ReadonlyArray<AcpMcpServer> | undefined, TContext>;
  /** Working directory for the session. Defaults to `ctx.cwdState.cwd`. */
  cwd?: Lazy<string | undefined, TContext>;
  /** Session mode to switch to before prompting (e.g. `'plan'`). */
  mode?: Lazy<string | undefined, TContext>;
  /** Model to select before prompting, for agents that expose model selection. */
  model?: Lazy<string | undefined, TContext>;
  /** Declarative answer to the agent's permission requests. Defaults to denying. */
  permissions?: AcpPermissionPolicy;
  /** Async resolver consulted when the policy and steering both abstain. */
  onPermissionRequest?: AcpPermissionHandler;
  /** Which client capabilities to advertise to the agent. */
  clientCapabilities?: AcpClientCapabilityConfig;
  /** Optional Standard Schema; when set the assistant text is JSON-parsed and validated. */
  output?: StandardSchemaV1<unknown, O>;
  /** Session reuse + teardown policy across steps. */
  session?: AcpSessionPolicy;
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
}

/** The operation names a call on `P`'s handle may use: its profile's, or any for a handle without one. */
export type CallOpName<P> = [
  P,
] extends [
  AnyProfile,
]
  ? OperationName<P>
  : string;

/** A call's argument type: the profile operation's input, or `unknown` without a profile. */
export type CallInput<P, Op extends string> = [
  P,
] extends [
  AnyProfile,
]
  ? Op extends OperationName<P>
    ? OperationInput<P, Op>
    : never
  : Readonly<Record<string, unknown>>;

/** A call's output type: the profile operation's output, or `unknown` without a profile. */
export type CallOutput<P, Op extends string> = [
  P,
] extends [
  AnyProfile,
]
  ? Op extends OperationName<P>
    ? OperationOutput<P, Op>
    : unknown
  : unknown;

/** `step.call`'s options. With a profiled handle, `op`, `args` and the output are typed by the profile. */
export interface CallOpts<TContext, I, P extends AnyProfile | undefined, Op extends string>
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, CallOutput<P, Op>> {
  id: string;
  /** A handle from `connection()`, or a harness connection name. */
  connection: ConnectionHandle<P> | string;
  op: Op;
  /** A value, or a function of the step's input. Secrets (`secret('name')`) go in `sensitive` fields. */
  args?:
    | CallInput<P, Op>
    | ((input: I, ctx: Context<TContext>) => CallInput<P, Op> | Promise<CallInput<P, Op>>);
}

/** `step.wait`'s options. */
export interface WaitOpts<TContext, I, A = unknown>
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, StepWaitOutput<unknown, A>> {
  id: string;
  connection: ConnectionHandle | string;
  /** The event type, e.g. `chat.message.created`. */
  event: string;
  /** Picks the event that ends the wait; every event of the type matches without one. */
  filter?: (event: ConnectionEvent, input: I, ctx: Context<TContext>) => boolean | Promise<boolean>;
  /** A step, or an array of steps run in sequence, run once listening has started. */
  around?: Step<TContext, I, A> | ReadonlyArray<Step<TContext, I, unknown>>;
  /** How long to wait, in ms, from when listening starts. Must be positive. */
  timeoutMs: number;
}

//#endregion

//#region Connection step validation

function requireStepId(builder: string, id: string | undefined): void {
  if (id && id.trim() !== '') {
    return;
  }
  throw new NoeticConfigError({
    code: 'EMPTY_STEP_ID',
    message: `${builder}() requires a non-empty id.`,
    hint: `Pass a unique string as the id field, e.g. ${builder}({ id: "my-step", ... }).`,
  });
}

function requireConnection(builder: string, id: string, connection: unknown): void {
  const named = typeof connection === 'string' && connection.length > 0;
  const handle =
    typeof connection === 'object' &&
    connection !== null &&
    'kind' in connection &&
    connection.kind === 'connection-handle';
  if (named || handle) {
    return;
  }
  throw new NoeticConfigError({
    code: 'CONNECTION_INVALID',
    message: `${builder}(${JSON.stringify(id)}) names no connection.`,
    hint: "Pass a handle from connection('name', profile), or a harness connection name.",
  });
}

const OP_NAME_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;

function requireOpName(id: string, op: string): void {
  if (OP_NAME_RE.test(op)) {
    return;
  }
  throw new NoeticConfigError({
    code: 'CONNECTION_INVALID',
    message: `step.call(${JSON.stringify(id)}) has operation ${JSON.stringify(op)}, which is not an operation name.`,
    hint: "An operation name has at least one dot, e.g. 'ui.tap' or 'chat.reply'.",
  });
}

function requireTimeout(id: string, timeoutMs: number): void {
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return;
  }
  throw new NoeticConfigError({
    code: 'CONNECTION_INVALID',
    message: `step.wait(${JSON.stringify(id)}) has timeoutMs ${timeoutMs}; it must be a positive number.`,
    hint: 'Give the longest the wait may take, in ms, e.g. timeoutMs: 18e5 for 30 minutes.',
  });
}

//#endregion

//#region ACP agent builder helper

/**
 * Validation shared by `step.acpAgent`. Kept separate from the builder so the
 * checks stay readable and the builder stays a one-liner.
 */
function validateAcpAgentOpts<TContext, O, I>(opts: StepAcpAgentOpts<TContext, O, I>): void {
  if (!opts.id || opts.id.trim() === '') {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ID',
      message: 'step.acpAgent() requires a non-empty id.',
      hint: 'Pass a unique string as the id field, e.g. step.acpAgent({ id: "review", ... }).',
    });
  }
  if (!opts.agent) {
    throw new NoeticConfigError({
      code: 'MISSING_ACP_AGENT',
      message: 'step.acpAgent() requires an agent adapter.',
      hint: 'Pass an agent factory result, e.g. agent: claudeCode() from @noetic-tools/acp.',
    });
  }
  // Presence, not emptiness: an empty `prompt` is a valid way to say "use the
  // step's runtime input as the prompt", which the handler supports.
  if (opts.prompt === undefined && opts.content === undefined) {
    throw new NoeticConfigError({
      code: 'MISSING_PROMPT',
      message: 'step.acpAgent() requires a prompt or content blocks.',
      hint: 'Pass `prompt` for plain text, or `content` for image/audio/resource blocks.',
    });
  }
}

/**
 * A forced tool must be one the step offers. Only an eager `tools` array can be
 * checked here; a getter's tools are checked when the request is built.
 */
function validateToolChoice<TContext, O, I>(opts: CallModelOpts<TContext, O, I>): void {
  const choice = opts.toolChoice;
  if (typeof choice !== 'object' || !Array.isArray(opts.tools)) {
    return;
  }
  const names = opts.tools.flatMap((entry) =>
    isServerToolSpec(entry)
      ? []
      : [
          entry.name,
        ],
  );
  if (names.includes(choice.tool)) {
    return;
  }
  throw new NoeticConfigError({
    code: 'UNKNOWN_TOOL_CHOICE',
    message: `callModel(${JSON.stringify(opts.id)}) forces tool ${JSON.stringify(choice.tool)}, which is not in its tools.`,
    hint:
      names.length > 0
        ? `Force one of the step's tools (${names.join(', ')}), or add '${choice.tool}' to \`tools\`.`
        : `Add '${choice.tool}' to \`tools\`, or drop \`toolChoice\`.`,
  });
}

//#endregion

//#region Builders

/**
 * Creates a pure async computation step.
 *
 * @public
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.execute - Async function `(input, ctx) => output` that performs the work.
 * @param opts.retry - Optional retry policy controlling attempts, backoff, and delay.
 * @param opts.subprocess - Optional per-step subprocess adapter override.
 * @returns A `StepRunCode` that can be composed into larger pipelines. The step
 *   is auto-registered in the shared step registry so the subprocess
 *   adapter can dispatch it by id.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `MISSING_EXECUTE_FUNCTION` if `execute` is not provided.
 */
export function runCode<
  TContext = ContextData,
  I = unknown,
  O = unknown,
  M extends CustomItemMap = CustomItemMap,
>(
  opts: RunCodeOpts<TContext, I, O, M>,
): StepRunCode<TContext, I, O> & CustomItemsBrand<M[keyof M]> {
  if (!opts.id || opts.id.trim() === '') {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ID',
      message: 'runCode() requires a non-empty id.',
      hint: 'Pass a unique string as the id field, e.g. runCode({ id: "my-step", ... }).',
    });
  }
  if (!opts.execute) {
    throw new NoeticConfigError({
      code: 'MISSING_EXECUTE_FUNCTION',
      message: 'runCode() requires an execute function.',
      hint: 'Provide an async execute function, e.g. execute: async (input, ctx) => result.',
    });
  }
  checkEmitItems(opts.id, opts, isGeneratorFunction(opts.execute));
  const built: StepRunCode<TContext, I, O> = {
    kind: 'runCode',
    ...opts,
  };
  getDefaultRegistrar().register(built);
  return built;
}

/**
 * Creates a model call step with optional tools and structured output.
 *
 * @public
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.model - Model identifier, eager string or `(ctx) => string` getter (resolved at step execution time).
 * @param opts.instructions - Optional system prompt; eager string or `(ctx) => string | undefined` getter.
 * @param opts.tools - Optional tools; eager array or `(ctx) => Tool[] | undefined` getter.
 * @param opts.output - Optional Zod schema enabling structured output parsing.
 * @param opts.toolChoice - Optional tool choice: `'auto'` (default), `'required'`, `'none'`, or `{ tool: name }`.
 * @param opts.params - Optional model parameters (temperature, topP, maxTokens, serviceTier).
 * @returns A `StepCallModel` that can be composed into larger pipelines. The step
 *   is auto-registered in the shared step registry.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `MISSING_MODEL` if an eager `model` string is empty. Function-form models are validated at step execution.
 * @throws `NoeticConfigError` with code `UNKNOWN_TOOL_CHOICE` if `toolChoice` forces a tool missing from an eager `tools` array.
 */
export function callModel<TContext = ContextData, I = unknown, O = unknown>(
  opts: CallModelOpts<TContext, O, I>,
): StepCallModel<TContext, I, O> {
  if (!opts.id || opts.id.trim() === '') {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ID',
      message: 'callModel() requires a non-empty id.',
      hint: 'Pass a unique string as the id field, e.g. callModel({ id: "my-llm", ... }).',
    });
  }
  // Only validate eager models here. Function-form models are validated
  // post-resolution in executeCallModel so the same MISSING_MODEL error surfaces
  // whether the caller passes a string or a getter.
  if (typeof opts.model === 'string' && opts.model.trim() === '') {
    throw new NoeticConfigError({
      code: 'MISSING_MODEL',
      message: 'callModel() requires a non-empty model.',
      hint: "Pass a model identifier, e.g. model: 'anthropic/claude-sonnet-4-20250514'.",
    });
  }
  validateToolChoice(opts);
  const built: StepCallModel<TContext, I, O> = {
    kind: 'callModel',
    ...opts,
  };
  getDefaultRegistrar().register(built);
  return built;
}

/**
 * Creates a tool execution step that invokes a typed tool definition.
 *
 * @public
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.tool - The tool definition with typed input/output schemas.
 * @param opts.args - Optional partial args that override or supplement model-provided arguments.
 * @returns A `StepInvokeTool` that can be composed into larger pipelines. The step
 *   is auto-registered in the shared step registry.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `MISSING_TOOL` if `tool` is not provided.
 */
export function invokeTool<TContext = ContextData, I = unknown, O = unknown>(
  opts: InvokeToolOpts<I, O, TContext>,
): StepInvokeTool<TContext, I, O> {
  if (!opts.id || opts.id.trim() === '') {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ID',
      message: 'invokeTool() requires a non-empty id.',
      hint: 'Pass a unique string as the id field, e.g. invokeTool({ id: "my-tool", ... }).',
    });
  }
  if (!opts.tool) {
    throw new NoeticConfigError({
      code: 'MISSING_TOOL',
      message: 'invokeTool() requires a tool.',
      hint: 'Provide a tool definition created with the tool() builder.',
    });
  }
  const built: StepInvokeTool<TContext, I, O> = {
    kind: 'invokeTool',
    ...opts,
  };
  getDefaultRegistrar().register(built);
  return built;
}

/**
 * The ACP step builder namespace. Unlike the flattened base builders
 * (`runCode`, `callModel`, `invokeTool`), the coding-agent builder stays
 * grouped under `step`.
 *
 * @public
 */
export const step = {
  /**
   * Creates a step that delegates a turn to an external coding agent over the
   * Agent Client Protocol.
   *
   * One builder covers every ACP-speaking agent: the agent itself is supplied
   * as an adapter, so adding an agent never changes this API or the published
   * workflow schema.
   *
   * @public
   * @param opts.id - Unique step identifier.
   * @param opts.agent - An agent adapter, e.g. `claudeCode()` from `@noetic-tools/acp`.
   * @param opts.prompt - The turn prompt; eager string or `(ctx) => string` getter.
   * @param opts.permissions - Declarative policy answering the agent's permission requests.
   * @param opts.output - Optional Standard Schema enabling structured output parsing.
   * @returns A `StepAcpAgent`, auto-registered in the step registry.
   * @throws `NoeticConfigError` `EMPTY_STEP_ID` / `MISSING_ACP_AGENT` / `MISSING_PROMPT`.
   */
  acpAgent<TContext = ContextData, I = unknown, O = unknown>(
    opts: StepAcpAgentOpts<TContext, O, I>,
  ): StepAcpAgent<TContext, I, O> {
    validateAcpAgentOpts(opts);
    const built: StepAcpAgent<TContext, I, O> = {
      kind: 'acp-agent',
      ...opts,
    };
    getDefaultRegistrar().register(built);
    return built;
  },

  /**
   * Creates a step that runs one connection operation and returns its result
   * (spec 35). With a handle from `connection(name, profile)`, `op`, `args` and
   * the output are typed by the profile. Long upstream operations are waited for.
   *
   * @public
   * @param opts.id - Unique step identifier.
   * @param opts.connection - A handle from `connection()`, or a harness connection name.
   * @param opts.op - The operation, e.g. `ui.tap`.
   * @param opts.args - A value, or a function of the step's input.
   * @returns A `StepCall`, auto-registered in the step registry.
   * @throws `NoeticConfigError` `EMPTY_STEP_ID`, or `CONNECTION_INVALID` for a missing connection or an operation name without a dot.
   */
  call<
    TContext = ContextData,
    I = unknown,
    P extends AnyProfile | undefined = undefined,
    const Op extends CallOpName<P> = CallOpName<P>,
  >(opts: CallOpts<TContext, I, P, Op>): StepCall<TContext, I, CallOutput<P, Op>> {
    requireStepId('step.call', opts.id);
    requireConnection('step.call', opts.id, opts.connection);
    requireOpName(opts.id, opts.op);
    const built: StepCall<TContext, I, CallOutput<P, Op>> = {
      kind: 'call',
      ...frameworkCast<Omit<StepCall<TContext, I, CallOutput<P, Op>>, 'kind'>>(opts),
    };
    getDefaultRegistrar().register(built);
    return built;
  },

  /**
   * Creates a step that waits for a connection event (spec 35). With `around`,
   * it starts listening, runs `around`, then waits, so the event an action
   * causes cannot slip past. Its output is `{ event, around }`.
   *
   * @public
   * @param opts.id - Unique step identifier.
   * @param opts.connection - A handle from `connection()`, or a harness connection name.
   * @param opts.event - The event type to wait for.
   * @param opts.filter - Picks the matching event: `(event, input, ctx) => boolean`.
   * @param opts.around - A step or an array of steps to run once listening has started.
   * @param opts.timeoutMs - How long to wait, in ms.
   * @returns A `StepWait`, auto-registered in the step registry.
   * @throws `NoeticConfigError` `EMPTY_STEP_ID`, or `CONNECTION_INVALID` for a missing connection, an empty event or a timeout that is not positive.
   */
  wait<TContext = ContextData, I = unknown, A = unknown>(
    opts: WaitOpts<TContext, I, A>,
  ): StepWait<TContext, I, StepWaitOutput<unknown, A>> {
    requireStepId('step.wait', opts.id);
    requireConnection('step.wait', opts.id, opts.connection);
    if (!opts.event) {
      throw new NoeticConfigError({
        code: 'CONNECTION_INVALID',
        message: `step.wait(${JSON.stringify(opts.id)}) names no event.`,
        hint: "Pass the event type to wait for, e.g. event: 'chat.message.created'.",
      });
    }
    requireTimeout(opts.id, opts.timeoutMs);
    const built: StepWait<TContext, I, StepWaitOutput<unknown, A>> = {
      kind: 'wait',
      ...frameworkCast<Omit<StepWait<TContext, I, StepWaitOutput<unknown, A>>, 'kind'>>(opts),
    };
    getDefaultRegistrar().register(built);
    return built;
  },

  /**
   * Creates a step that checks claims about what a connection shows (spec 37):
   * it declares what should become true, runs `act`, watches the connection's
   * senses, and answers with the evidence. See `verify` in `./verify-builder`.
   *
   * @public
   */
  verify,
};

//#endregion
