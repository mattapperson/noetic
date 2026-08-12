import type { ContextData } from '@noetic-tools/context';
import type {
  Context,
  Lazy,
  ModelParams,
  OutputCodec,
  RetryPolicy,
  ServerToolSpec,
  StandardSchemaV1,
  StepCallModel,
  StepInvokeTool,
  StepRunCode,
  StepSubHarness,
  SubHarness,
  SubHarnessKind,
  SubHarnessSessionPolicy,
  SubHarnessSettings,
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

export interface StepSubHarnessOpts<TContext, O> {
  id: string;
  /** The harness adapter created by a `@noetic-tools/sub-harness-*` factory. Eager or `(ctx) => SubHarness`. */
  harness: Lazy<SubHarness, TContext>;
  /** Turn prompt. Eager string or `(ctx) => string` getter. */
  prompt: Lazy<string, TContext>;
  /** Shared harness settings (model, permission mode, …). */
  settings?: SubHarnessSettings;
  /** System instructions applied on the first message of a fresh session. */
  instructions?: Lazy<string | undefined, TContext>;
  /** Optional Standard Schema; when set the assistant text is JSON-parsed and validated. */
  output?: StandardSchemaV1<unknown, O>;
  /** Session reuse + teardown policy across steps. */
  session?: SubHarnessSessionPolicy;
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
}

//#endregion

//#region SubHarness builder helper

/**
 * Shared construction for every harness step kind. Each `step.<kind>()` is a
 * thin wrapper so the kinds stay individually typed while the validation and
 * registration live in one place.
 */
function buildSubHarnessStep<TContext, I, O>(
  kind: SubHarnessKind,
  builderName: string,
  opts: StepSubHarnessOpts<TContext, O>,
): StepSubHarness<TContext, I, O> {
  if (!opts.id || opts.id.trim() === '') {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ID',
      message: `${builderName}() requires a non-empty id.`,
      hint: `Pass a unique string as the id field, e.g. ${builderName}({ id: "review", ... }).`,
    });
  }
  if (!opts.harness) {
    throw new NoeticConfigError({
      code: 'MISSING_SUB_HARNESS',
      message: `${builderName}() requires a harness adapter.`,
      hint: `Pass a harness factory result, e.g. harness: ${builderName.replace('step.', '')}({ model }).`,
    });
  }
  // Eager adapters are validated now; function-form adapters are validated
  // post-resolution in executeSubHarness so the same SUB_HARNESS_KIND_MISMATCH
  // error surfaces whether the caller passes an adapter or a getter.
  if (typeof opts.harness !== 'function' && opts.harness.harnessId !== kind) {
    throw new NoeticConfigError({
      code: 'SUB_HARNESS_KIND_MISMATCH',
      message: `${builderName}() was given a '${opts.harness.harnessId}' harness.`,
      hint: `Use the matching builder, e.g. step.${opts.harness.harnessId}({ ... }).`,
    });
  }
  const built: StepSubHarness<TContext, I, O> = {
    kind,
    ...opts,
  };
  getDefaultRegistrar().register(built);
  return built;
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
 * The sub-harness step builder namespace. Unlike the flattened base builders
 * (`runCode`, `callModel`, `invokeTool`), the coding-agent harness builders
 * stay grouped under `step` — their `step.<harness>()` API is unchanged.
 *
 * @public
 */
export const step = {
  /**
   * Creates a step that delegates a turn to the Claude Code harness.
   *
   * @public
   * @param opts.id - Unique step identifier.
   * @param opts.harness - A `claudeCode(...)` adapter from `@noetic-tools/sub-harness-claude-code`.
   * @param opts.prompt - The turn prompt; eager string or `(ctx) => string` getter.
   * @param opts.settings - Shared harness settings (model, permission mode, …).
   * @param opts.output - Optional Zod schema enabling structured output parsing.
   * @returns A `StepSubHarness` of kind `claude-code`, auto-registered in the step registry.
   * @throws `NoeticConfigError` `EMPTY_STEP_ID` / `MISSING_SUB_HARNESS` / `SUB_HARNESS_KIND_MISMATCH`.
   */
  claudeCode<TContext = ContextData, I = unknown, O = unknown>(
    opts: StepSubHarnessOpts<TContext, O>,
  ): StepSubHarness<TContext, I, O> {
    return buildSubHarnessStep('claude-code', 'step.claudeCode', opts);
  },

  /**
   * Creates a step that delegates a turn to the Codex harness.
   * @public
   * @param opts - See {@link step.claudeCode}; `opts.harness` is a `codex(...)` adapter.
   * @returns A `StepSubHarness` of kind `codex`.
   */
  codex<TContext = ContextData, I = unknown, O = unknown>(
    opts: StepSubHarnessOpts<TContext, O>,
  ): StepSubHarness<TContext, I, O> {
    return buildSubHarnessStep('codex', 'step.codex', opts);
  },

  /**
   * Creates a step that delegates a turn to the opencode harness.
   * @public
   * @param opts - See {@link step.claudeCode}; `opts.harness` is an `opencode(...)` adapter.
   * @returns A `StepSubHarness` of kind `opencode`.
   */
  opencode<TContext = ContextData, I = unknown, O = unknown>(
    opts: StepSubHarnessOpts<TContext, O>,
  ): StepSubHarness<TContext, I, O> {
    return buildSubHarnessStep('opencode', 'step.opencode', opts);
  },

  /**
   * Creates a step that delegates a turn to the pi harness.
   * @public
   * @param opts - See {@link step.claudeCode}; `opts.harness` is a `pi(...)` adapter.
   * @returns A `StepSubHarness` of kind `pi`.
   */
  pi<TContext = ContextData, I = unknown, O = unknown>(
    opts: StepSubHarnessOpts<TContext, O>,
  ): StepSubHarness<TContext, I, O> {
    return buildSubHarnessStep('pi', 'step.pi', opts);
  },
};

//#endregion
