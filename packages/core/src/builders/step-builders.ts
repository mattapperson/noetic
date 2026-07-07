import type { ContextMemory } from '@noetic-tools/memory';
import type {
  Context,
  Lazy,
  ModelParams,
  OutputCodec,
  RetryPolicy,
  ServerToolSpec,
  StepLLM,
  StepRun,
  StepSubHarness,
  StepTool,
  SubHarness,
  SubHarnessKind,
  SubHarnessSessionPolicy,
  SubHarnessSettings,
  SubprocessAdapter,
  Tool,
} from '@noetic-tools/types';
import { NoeticConfigError } from '@noetic-tools/types';
import type { ZodType } from 'zod';
import { getDefaultRegistrar } from '../types/step-registrar';

//#region Types

interface StepRunOpts<TMemory, I, O> {
  id: string;
  execute: (input: I, ctx: Context<TMemory>) => Promise<O>;
  retry?: RetryPolicy;
  /**
   * Optional subprocess adapter override. When set, `execute()` is routed
   * through this adapter instead of the harness default. See spec 04 for
   * precedence rules.
   */
  subprocess?: SubprocessAdapter;
}

interface StepLLMOpts<TMemory, O> {
  id: string;
  /** Model id. Eager string or `(ctx) => string` getter (resolved at step execution). */
  model: Lazy<string, TMemory>;
  /** Optional instructions; eager string or `(ctx) => string | undefined` getter. */
  instructions?: Lazy<string | undefined, TMemory>;
  /**
   * Optional tools; eager array or `(ctx) => (...)[] | undefined` getter. Each
   * entry is either a client `Tool` or an inline `ServerToolSpec` (an OpenRouter
   * server tool the provider executes, e.g. web search/fetch).
   */
  tools?: Lazy<(Tool | ServerToolSpec)[] | undefined, TMemory>;
  /** Structured output: a Zod schema or a streaming `OutputCodec` (e.g. OpenUI Lang). */
  output?: ZodType<O> | OutputCodec<O>;
  params?: ModelParams;
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
}

interface StepToolOpts<I, O> {
  id: string;
  tool: Tool<ZodType<I>, ZodType<O>>;
  args?: Partial<I>;
}

interface StepSubHarnessOpts<TMemory, O> {
  id: string;
  /** The harness adapter created by a `@noetic-tools/sub-harness-*` factory. Eager or `(ctx) => SubHarness`. */
  harness: Lazy<SubHarness, TMemory>;
  /** Turn prompt. Eager string or `(ctx) => string` getter. */
  prompt: Lazy<string, TMemory>;
  /** Shared harness settings (model, permission mode, …). */
  settings?: SubHarnessSettings;
  /** System instructions applied on the first message of a fresh session. */
  instructions?: Lazy<string | undefined, TMemory>;
  /** Optional Zod schema; when set the assistant text is JSON-parsed and validated. */
  output?: ZodType<O>;
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
function buildSubHarnessStep<TMemory, I, O>(
  kind: SubHarnessKind,
  builderName: string,
  opts: StepSubHarnessOpts<TMemory, O>,
): StepSubHarness<TMemory, I, O> {
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
  const built: StepSubHarness<TMemory, I, O> = {
    kind,
    ...opts,
  };
  getDefaultRegistrar().register(built);
  return built;
}

//#endregion

//#region Builders

export const step = {
  /**
   * Creates a pure async computation step.
   *
   * @public
   * @param opts.id - Unique step identifier used in traces and error messages.
   * @param opts.execute - Async function `(input, ctx) => output` that performs the work.
   * @param opts.retry - Optional retry policy controlling attempts, backoff, and delay.
   * @param opts.subprocess - Optional per-step subprocess adapter override.
   * @returns A `StepRun` that can be composed into larger pipelines. The step
   *   is auto-registered in the shared step registry so the subprocess
   *   adapter can dispatch it by id.
   * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
   * @throws `NoeticConfigError` with code `MISSING_EXECUTE_FUNCTION` if `execute` is not provided.
   * @throws `NoeticConfigError` with code `DUPLICATE_STEP_ID` if another step with the same id is already registered with a different body.
   */
  run<TMemory = ContextMemory, I = unknown, O = unknown>(
    opts: StepRunOpts<TMemory, I, O>,
  ): StepRun<TMemory, I, O> {
    if (!opts.id || opts.id.trim() === '') {
      throw new NoeticConfigError({
        code: 'EMPTY_STEP_ID',
        message: 'step.run() requires a non-empty id.',
        hint: 'Pass a unique string as the id field, e.g. step.run({ id: "my-step", ... }).',
      });
    }
    if (!opts.execute) {
      throw new NoeticConfigError({
        code: 'MISSING_EXECUTE_FUNCTION',
        message: 'step.run() requires an execute function.',
        hint: 'Provide an async execute function, e.g. execute: async (input, ctx) => result.',
      });
    }
    const built: StepRun<TMemory, I, O> = {
      kind: 'run',
      ...opts,
    };
    getDefaultRegistrar().register(built);
    return built;
  },

  /**
   * Creates an LLM model call step with optional tools and structured output.
   *
   * @public
   * @param opts.id - Unique step identifier used in traces and error messages.
   * @param opts.model - Model identifier, eager string or `(ctx) => string` getter (resolved at step execution time).
   * @param opts.instructions - Optional system prompt; eager string or `(ctx) => string | undefined` getter.
   * @param opts.tools - Optional tools; eager array or `(ctx) => Tool[] | undefined` getter.
   * @param opts.output - Optional Zod schema enabling structured output parsing.
   * @param opts.params - Optional model parameters (temperature, topP, maxTokens, stopSequences).
   * @returns A `StepLLM` that can be composed into larger pipelines. The step
   *   is auto-registered in the shared step registry.
   * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
   * @throws `NoeticConfigError` with code `MISSING_MODEL` if an eager `model` string is empty. Function-form models are validated at step execution.
   */
  llm<TMemory = ContextMemory, I = unknown, O = unknown>(
    opts: StepLLMOpts<TMemory, O>,
  ): StepLLM<TMemory, I, O> {
    if (!opts.id || opts.id.trim() === '') {
      throw new NoeticConfigError({
        code: 'EMPTY_STEP_ID',
        message: 'step.llm() requires a non-empty id.',
        hint: 'Pass a unique string as the id field, e.g. step.llm({ id: "my-llm", ... }).',
      });
    }
    // Only validate eager models here. Function-form models are validated
    // post-resolution in executeLLM so the same MISSING_MODEL error surfaces
    // whether the caller passes a string or a getter.
    if (typeof opts.model === 'string' && opts.model.trim() === '') {
      throw new NoeticConfigError({
        code: 'MISSING_MODEL',
        message: 'step.llm() requires a non-empty model.',
        hint: "Pass a model identifier, e.g. model: 'anthropic/claude-sonnet-4-20250514'.",
      });
    }
    const built: StepLLM<TMemory, I, O> = {
      kind: 'llm',
      ...opts,
    };
    getDefaultRegistrar().register(built);
    return built;
  },

  /**
   * Creates a tool execution step that invokes a typed tool definition.
   *
   * @public
   * @param opts.id - Unique step identifier used in traces and error messages.
   * @param opts.tool - The tool definition with typed input/output schemas.
   * @param opts.args - Optional partial args that override or supplement LLM-provided arguments.
   * @returns A `StepTool` that can be composed into larger pipelines. The step
   *   is auto-registered in the shared step registry.
   * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
   * @throws `NoeticConfigError` with code `MISSING_TOOL` if `tool` is not provided.
   */
  tool<TMemory = ContextMemory, I = unknown, O = unknown>(
    opts: StepToolOpts<I, O>,
  ): StepTool<TMemory, I, O> {
    if (!opts.id || opts.id.trim() === '') {
      throw new NoeticConfigError({
        code: 'EMPTY_STEP_ID',
        message: 'step.tool() requires a non-empty id.',
        hint: 'Pass a unique string as the id field, e.g. step.tool({ id: "my-tool", ... }).',
      });
    }
    if (!opts.tool) {
      throw new NoeticConfigError({
        code: 'MISSING_TOOL',
        message: 'step.tool() requires a tool.',
        hint: 'Provide a tool definition created with the tool() builder.',
      });
    }
    const built: StepTool<TMemory, I, O> = {
      kind: 'tool',
      ...opts,
    };
    getDefaultRegistrar().register(built);
    return built;
  },

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
  claudeCode<TMemory = ContextMemory, I = unknown, O = unknown>(
    opts: StepSubHarnessOpts<TMemory, O>,
  ): StepSubHarness<TMemory, I, O> {
    return buildSubHarnessStep('claude-code', 'step.claudeCode', opts);
  },

  /**
   * Creates a step that delegates a turn to the Codex harness.
   * @public
   * @param opts - See {@link step.claudeCode}; `opts.harness` is a `codex(...)` adapter.
   * @returns A `StepSubHarness` of kind `codex`.
   */
  codex<TMemory = ContextMemory, I = unknown, O = unknown>(
    opts: StepSubHarnessOpts<TMemory, O>,
  ): StepSubHarness<TMemory, I, O> {
    return buildSubHarnessStep('codex', 'step.codex', opts);
  },

  /**
   * Creates a step that delegates a turn to the opencode harness.
   * @public
   * @param opts - See {@link step.claudeCode}; `opts.harness` is an `opencode(...)` adapter.
   * @returns A `StepSubHarness` of kind `opencode`.
   */
  opencode<TMemory = ContextMemory, I = unknown, O = unknown>(
    opts: StepSubHarnessOpts<TMemory, O>,
  ): StepSubHarness<TMemory, I, O> {
    return buildSubHarnessStep('opencode', 'step.opencode', opts);
  },

  /**
   * Creates a step that delegates a turn to the pi harness.
   * @public
   * @param opts - See {@link step.claudeCode}; `opts.harness` is a `pi(...)` adapter.
   * @returns A `StepSubHarness` of kind `pi`.
   */
  pi<TMemory = ContextMemory, I = unknown, O = unknown>(
    opts: StepSubHarnessOpts<TMemory, O>,
  ): StepSubHarness<TMemory, I, O> {
    return buildSubHarnessStep('pi', 'step.pi', opts);
  },
};

//#endregion
