import type { ContextData } from '@noetic-tools/context';
import type {
  AcpAgent,
  AcpClientCapabilityConfig,
  AcpContentBlock,
  AcpMcpServer,
  AcpPermissionHandler,
  AcpPermissionPolicy,
  AcpSessionPolicy,
  Context,
  Lazy,
  ModelParams,
  OutputCodec,
  RetryPolicy,
  ServerToolSpec,
  StandardSchemaV1,
  StepAcpAgent,
  StepCallModel,
  StepInvokeTool,
  StepRunCode,
  SubprocessAdapter,
  Tool,
} from '@noetic-tools/types';
import { NoeticConfigError } from '@noetic-tools/types';
import { getDefaultRegistrar } from '../types/step-registrar';

//#region Types

export interface RunCodeOpts<TContext, I, O> {
  id: string;
  execute: (input: I, ctx: Context<TContext>) => Promise<O>;
  retry?: RetryPolicy;
  /**
   * Optional subprocess adapter override. When set, `execute()` is routed
   * through this adapter instead of the harness default. See spec 04 for
   * precedence rules.
   */
  subprocess?: SubprocessAdapter;
}

export interface CallModelOpts<TContext, O> {
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

export interface InvokeToolOpts<I, O> {
  id: string;
  tool: Tool<StandardSchemaV1<unknown, I>, StandardSchemaV1<unknown, O>>;
  args?: Partial<I>;
}

export interface StepAcpAgentOpts<TContext, O> {
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

//#endregion

//#region ACP agent builder helper

/**
 * Validation shared by `step.acpAgent`. Kept separate from the builder so the
 * checks stay readable and the builder stays a one-liner.
 */
function validateAcpAgentOpts<TContext, O>(opts: StepAcpAgentOpts<TContext, O>): void {
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
 * @throws `NoeticConfigError` with code `DUPLICATE_STEP_ID` if another step with the same id is already registered with a different body.
 */
export function runCode<TContext = ContextData, I = unknown, O = unknown>(
  opts: RunCodeOpts<TContext, I, O>,
): StepRunCode<TContext, I, O> {
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
 * @param opts.params - Optional model parameters (temperature, topP, maxTokens, stopSequences).
 * @returns A `StepCallModel` that can be composed into larger pipelines. The step
 *   is auto-registered in the shared step registry.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `MISSING_MODEL` if an eager `model` string is empty. Function-form models are validated at step execution.
 */
export function callModel<TContext = ContextData, I = unknown, O = unknown>(
  opts: CallModelOpts<TContext, O>,
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
  opts: InvokeToolOpts<I, O>,
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
    opts: StepAcpAgentOpts<TContext, O>,
  ): StepAcpAgent<TContext, I, O> {
    validateAcpAgentOpts(opts);
    const built: StepAcpAgent<TContext, I, O> = {
      kind: 'acp-agent',
      ...opts,
    };
    getDefaultRegistrar().register(built);
    return built;
  },
};

//#endregion
