import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Channel } from './channel';
import type { ModelParams, RetryPolicy, ServerToolSpec, StepMeta } from './common';
import type { Context } from './context';
import type { ContextConfig, ContextData, ContextLayer, ProjectionPolicy } from './context-layer';
import type { NoeticError } from './error';
import type { OutputCodec } from './output-codec';
import type {
  SubHarness,
  SubHarnessKind,
  SubHarnessSessionPolicy,
  SubHarnessSettings,
} from './sub-harness';
import type { SubprocessAdapter } from './subprocess-adapter';
import type { Tool } from './tool';

/**
 * Cumulative execution snapshot passed to loop `until` predicates.
 * @public
 */
export interface Snapshot {
  /** Number of loop iterations completed so far. */
  stepCount: number;
  /** Aggregate token usage across all iterations. */
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  /** Wall-clock time in ms since the loop started. */
  elapsed: number;
  /** Cumulative cost across all iterations. */
  cost: number;
  /** Raw output of the most recent iteration. */
  lastOutput: unknown;
  /** Stringified text of the most recent iteration output. */
  lastText: string;
  /** Array of all prior iteration outputs (bounded by `maxHistorySize`). */
  history: unknown[];
  /** Nesting depth of the current execution context. */
  depth: number;
  /** Metadata from the most recent step execution (token usage, tool calls, etc.). */
  lastStepMeta?: StepMeta | null;
}

/**
 * Decision returned by a loop `until` predicate.
 * @public
 */
export interface Verdict {
  /** When true, the loop terminates after this iteration. */
  stop: boolean;
  /** Human-readable explanation of why the loop stopped (logged in traces). */
  reason?: string;
  /** Feedback string injected into the next iteration's context (ignored when `stop` is true). */
  feedback?: string;
}

/** @public Predicate function evaluated after each loop iteration to decide whether to stop. */
export type Until = (snapshot: Snapshot) => Verdict | Promise<Verdict>;

/**
 * Field type that accepts either an eager value or a `(ctx) => value` getter.
 * Used by `step.llm` for params that may vary per execution (model, instructions,
 * tool list). The getter runs at step execution time with the live context.
 * @public
 */
export type Lazy<T, TContext = ContextData> = T | ((ctx: Context<TContext>) => T | Promise<T>);

/**
 * Outcome of a single path in a `settle`-mode fork (mirrors `Promise.allSettled`).
 * @public
 */
export interface SettleResult<O> {
  /** Id of the step that produced this result. */
  stepId: string;
  /** Whether the path completed successfully or threw. */
  status: 'fulfilled' | 'rejected';
  /** The path's return value (present when `status` is `'fulfilled'`). */
  value?: O;
  /** The error that caused rejection (present when `status` is `'rejected'`). */
  error?: NoeticError;
}

/** @public Discriminated union of all step kinds that can be composed into an execution tree. */
export type Step<TContext = ContextData, I = unknown, O = unknown> =
  | StepRun<TContext, I, O>
  | StepLLM<TContext, I, O>
  | StepSubHarness<TContext, I, O>
  | StepTool<TContext, I, O>
  | StepBranch<TContext, I, O>
  | StepFork<TContext, I, O>
  | StepSpawn<TContext, I, O>
  | StepProvide<TContext, I, O>
  | StepLoop<TContext, I, O>
  | StepEvery<TContext, I, O>;

/** @public A step that executes arbitrary async logic via a user-supplied function. */
export interface StepRun<TContext = ContextData, I = unknown, O = unknown> {
  kind: 'run';
  id: string;
  execute: (input: I, ctx: Context<TContext>) => Promise<O>;
  retry?: RetryPolicy;
  /**
   * Per-step subprocess adapter override. When set, the interpreter
   * dispatches this step through the given adapter instead of the harness
   * default. Resolution order at dispatch is
   * `detachedSpawn-overrides.subprocess ?? step.subprocess ?? harness.subprocess`.
   */
  subprocess?: SubprocessAdapter;
}

/** @public A step that sends a prompt to a language model and returns its response. */
export interface StepLLM<TContext = ContextData, _I = unknown, O = unknown> {
  kind: 'llm';
  id: string;
  /** Model id. Accepts either an eager string or a `(ctx) => string` getter. */
  model: Lazy<string, TContext>;
  /** System instructions. Eager string or `(ctx) => string | undefined` getter. */
  instructions?: Lazy<string | undefined, TContext>;
  /**
   * Tools exposed to the LLM. Eager array or `(ctx) => (...)[] | undefined` getter.
   * Entries are either a client `Tool` or an inline `ServerToolSpec` (an
   * OpenRouter server tool the provider executes, e.g. web search/fetch).
   * Function-form tools do not contribute to the pre-computed `ctx.unifiedTools`;
   * they are resolved per execution.
   */
  tools?: Lazy<(Tool | ServerToolSpec)[] | undefined, TContext>;
  /**
   * Structured output: a Standard Schema (assistant text is JSON-parsed and
   * validated) or a streaming `OutputCodec` (fed each text delta, produces
   * the typed value at turn end). Non-Zod schemas require `outputJsonSchema`
   * so the model receives a JSON Schema constraint.
   */
  output?: StandardSchemaV1<unknown, O> | OutputCodec<O>;
  /**
   * Explicit raw JSON Schema sent to the model as the structured-output
   * constraint. Required when `output` is a non-Zod Standard Schema; ignored
   * for Zod schemas, whose JSON Schema is derived automatically.
   */
  outputJsonSchema?: Record<string, unknown>;
  params?: ModelParams;
  /** Controls framework event emission for this step. Defaults to `true`. Set `false` to suppress all framework events. A filter function receives `(eventType, data)` and returns `boolean`. */
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
  /** Projection policy for this step's context window. Overrides the harness-level default. */
  projection?: ProjectionPolicy;
}

/**
 * A step that delegates a turn to an external coding-agent harness
 * (Claude Code, Codex, opencode, pi). Each harness kind is a distinct
 * `Step.kind`, but every variant shares this shape and is executed by one
 * interpreter handler.
 * @public
 */
export interface StepSubHarness<TContext = ContextData, _I = unknown, O = unknown> {
  /** The harness kind, equal to the backing adapter's `harnessId`. */
  kind: SubHarnessKind;
  id: string;
  /**
   * The harness adapter that runs the turn. Eager or `(ctx) => SubHarness`.
   * Programmatic builders take it inline; the JSON hydrator resolves it from
   * the workflow's harness registry and inlines it here.
   */
  harness: Lazy<SubHarness, TContext>;
  /** Turn prompt. Eager string or `(ctx) => string` getter. */
  prompt: Lazy<string, TContext>;
  /** Shared harness settings (model, permission mode, …). */
  settings?: SubHarnessSettings;
  /** System instructions applied on the first message of a fresh session. */
  instructions?: Lazy<string | undefined, TContext>;
  /** When set, the assistant text is JSON-parsed and validated against this Standard Schema. */
  output?: StandardSchemaV1<unknown, O>;
  /** Session reuse + teardown policy across steps. */
  session?: SubHarnessSessionPolicy;
  /** Controls framework event emission for this step. Defaults to `true`. */
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
}

/** @public A step that invokes a single tool directly, bypassing the LLM. */
export interface StepTool<_TContext = ContextData, I = unknown, O = unknown> {
  kind: 'tool';
  id: string;
  tool: Tool<StandardSchemaV1<unknown, I>, StandardSchemaV1<unknown, O>>;
  args?: Partial<I>;
}

/** @public A step that dynamically selects and executes one of several possible sub-steps. */
export interface StepBranch<TContext = ContextData, I = unknown, O = unknown> {
  kind: 'branch';
  id: string;
  route: (
    input: I,
    ctx: Context<TContext>,
  ) => Step<TContext, I, O> | null | Promise<Step<TContext, I, O> | null>;
  _optimizable?: Step<TContext>[];
}

/** @public Union of fork step variants (`race`, `all`, `settle`) for concurrent path execution. */
export type StepFork<TContext = ContextData, I = unknown, O = unknown> =
  | StepForkRace<TContext, I, O>
  | StepForkAll<TContext, I, O>
  | StepForkSettle<TContext, I, O>;

/** @public A fork step that returns the result of the first path to complete. */
export interface StepForkRace<TContext = ContextData, I = unknown, O = unknown> {
  kind: 'fork';
  id: string;
  mode: 'race';
  paths: (input: I, ctx: Context<TContext>) => Step<TContext, I, O>[];
  concurrency?: number;
  _optimizable?: Step<TContext>[];
}

/** @public A fork step that runs all paths and merges their results. */
export interface StepForkAll<TContext = ContextData, I = unknown, O = unknown> {
  kind: 'fork';
  id: string;
  mode: 'all';
  paths: (input: I, ctx: Context<TContext>) => Step<TContext, I, O>[];
  merge: (results: O[], ctx: Context<TContext>) => O;
  concurrency?: number;
  _optimizable?: Step<TContext>[];
}

/** @public A fork step that runs all paths and collects fulfilled/rejected outcomes. */
export interface StepForkSettle<TContext = ContextData, I = unknown, O = unknown> {
  kind: 'fork';
  id: string;
  mode: 'settle';
  paths: (input: I, ctx: Context<TContext>) => Step<TContext, I, O>[];
  merge: (results: SettleResult<O>[], ctx: Context<TContext>) => O;
  concurrency?: number;
  _optimizable?: Step<TContext>[];
}

/**
 * A step that provides context layers to its child without creating an isolated context.
 * Like React's Context.Provider — layers are available to all descendant steps.
 * Spawn and detachedSpawn break the inheritance chain.
 * @public
 */
export interface StepProvide<TContext = ContextData, I = unknown, O = unknown> {
  kind: 'provide';
  id: string;
  child: Step<TContext, I, O>;
  context: ContextConfig | ContextLayer[];
}

/** @public A step that launches a child execution with its own context scope. */
export interface StepSpawn<TContext = ContextData, I = unknown, O = unknown> {
  kind: 'spawn';
  id: string;
  child: Step<TContext, I, O>;
  context?: ContextConfig | ContextLayer[];
  timeout?: number;
  /**
   * Per-step subprocess adapter override applied when the interpreter
   * dispatches this spawn. Resolution order is
   * `detachedSpawn-overrides.subprocess ?? step.subprocess ?? harness.subprocess`.
   */
  subprocess?: SubprocessAdapter;
}

/**
 * A loop step that iterates a body step until a termination predicate is satisfied.
 * @public
 */
export interface StepLoop<TContext = ContextData, I = unknown, O = unknown> {
  kind: 'loop';
  /** Unique step identifier used in traces and error messages. */
  id: string;
  /** Steps to execute sequentially on each iteration. */
  steps: ReadonlyArray<Step<TContext, I, O>>;
  /** Termination predicate evaluated after each iteration with a cumulative snapshot. */
  until: Until;
  /** Hard safety cap on iterations (default: 1000). */
  maxIterations?: number;
  /** Maximum number of entries kept in the snapshot history array. */
  maxHistorySize?: number;
  /** Optional channel for injecting messages into the loop mid-execution. */
  inbox?: Channel<string>;
  /** Ms to wait on inbox before the loop parks itself (default: 0 = no parking). */
  parkTimeout?: number;
  /** Transforms the previous iteration's output into the next iteration's input. */
  prepareNext?: (output: O, verdict: Verdict, ctx: Context<TContext>) => I;
  /** Per-iteration error handler: retry the iteration, skip it, or abort the loop. */
  onError?: (error: NoeticError, ctx: Context<TContext>) => 'retry' | 'skip' | 'abort';
}

/**
 * Error policy for the `every` operator when its body step throws.
 * - `'continue'` (default): emit a span event recording the error and continue parking.
 * - `'fail'`: re-throw, terminating the operator.
 * @public
 */
export type EveryErrorPolicy = 'continue' | 'fail';

/**
 * A step that runs a body step on a fixed-interval schedule, optionally woken
 * sooner by a wake channel. Runs forever until the executing context is cancelled.
 *
 * The operator output is `void` — `every` does not accumulate iteration outputs.
 * The `O` type parameter exists only to anchor the body step's output type.
 *
 * @public
 */
export interface StepEvery<TContext = ContextData, I = unknown, O = unknown> {
  kind: 'every';
  /** Unique step identifier used in traces and error messages. */
  id: string;
  /** Body step executed on each iteration. */
  step: Step<TContext, I, O>;
  /** Park duration between iterations in milliseconds. Must be >= 0. */
  ms: number;
  /** Optional channel that wakes the parking interval when any value arrives. */
  wakeOn?: Channel<unknown>;
  /** Behavior when `step` throws. Defaults to `'continue'`. */
  onError?: EveryErrorPolicy;
  /** Random jitter applied to the park duration in milliseconds. Must be >= 0. Default 0. */
  jitter?: number;
}

/** @public Function signature used by the interpreter to recursively execute a step. */
export type ExecuteStepFn = <TContext, I, O>(
  step: Step<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
) => Promise<O>;
