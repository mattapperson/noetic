import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
  AcpAgent,
  AcpClientCapabilityConfig,
  AcpContentBlock,
  AcpMcpServer,
  AcpPermissionHandler,
  AcpPermissionPolicy,
  AcpSessionPolicy,
} from './acp';
import type { Channel } from './channel';
import type { ModelParams, RetryPolicy, ServerToolSpec, StepMeta } from './common';
import type { Context } from './context';
import type { ContextConfig, ContextData, ContextLayer, ProjectionPolicy } from './context-layer';
import type { DecideAnswers, DecideQuestions } from './decide';
import type { NoeticError } from './error';
import type { OutputCodec } from './output-codec';
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
  /** Prior iteration outputs, oldest first; bounded by `maxHistorySize` (default 100, oldest dropped first). */
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
  /** Why the loop stopped or continued; recorded on the `loop.verdict` span event. */
  reason?: string;
  /** Feedback string injected into the next iteration's context (ignored when `stop` is true). */
  feedback?: string;
}

/**
 * What a loop hands its `until` predicate so the predicate can run steps — a
 * decide step used as the predicate runs through it. Predicates that only read
 * the snapshot ignore it.
 * @public
 */
export interface UntilRun {
  ctx: Context;
  executeStep: ExecuteStepFn;
}

/** @public Predicate function evaluated after each loop iteration to decide whether to stop. */
export type Until = (snapshot: Snapshot, run?: UntilRun) => Verdict | Promise<Verdict>;

/**
 * Field type that accepts either an eager value or a `(ctx) => value` getter.
 * Used by `step.callModel` for params that may vary per execution (model,
 * instructions, tool list). The getter runs at step execution time with the
 * live context.
 * @public
 */
export type Lazy<T, TContext = ContextData> = T | ((ctx: Context<TContext>) => T | Promise<T>);

/**
 * Outcome of a single path in a `settle`-mode inParallel step (mirrors `Promise.allSettled`).
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

/**
 * Combines inParallel path results into one output. `R` is the element type of
 * `results`: `O` in `all` mode, `SettleResult<O>` in `settle` mode.
 * @public
 */
export type MergeFn<TContext = ContextData, O = unknown, R = O> = (
  results: R[],
  ctx: Context<TContext>,
) => O;

/**
 * Replay controls shared by every step kind (spec 23a § Identity).
 *
 * A resumed execution replays a recorded step's output in place of running it.
 * By default the ledger keys that record by the step's execution path, so replay
 * identity is positional. These fields change that per step.
 * @public
 */
export interface StepReplay<TContext = ContextData, I = unknown> {
  /**
   * Whether the ledger records and replays this step. Defaults to `true`. With
   * `false` the step always runs again on resume, so its side effects and state
   * changes happen again too. Use it for cheap orchestration steps whose work is
   * timing-dependent (which batch a worker picked) or lives in state rather than
   * output. Applies to this step only: its children keep their own setting.
   * `schedule` steps are never recorded, whatever this says.
   */
  durable?: boolean;
  /**
   * Content key that replaces the positional path as this step's ledger key, so a
   * step that may run at a different position on resume (a concurrent worker's
   * call) still finds its own output. Two dispatches with the same key in one
   * execution share one entry. A key that throws skips the ledger for that
   * dispatch with a warning; it never fails the step.
   */
  replayKey?(input: I, ctx: Context<TContext>): string;
}

/** @public Discriminated union of all step kinds that can be composed into an execution tree. */
export type Step<TContext = ContextData, I = unknown, O = unknown> =
  | StepRunCode<TContext, I, O>
  | StepCallModel<TContext, I, O>
  | StepAcpAgent<TContext, I, O>
  | StepInvokeTool<TContext, I, O>
  | StepDecide<TContext, I, O>
  | StepConditional<TContext, I, O>
  | StepInParallel<TContext, I, O>
  | StepSpawn<TContext, I, O>
  | StepWithContext<TContext, I, O>
  | StepLoop<TContext, I, O>
  | StepSchedule<TContext, I, O>;

/** @public A step that executes arbitrary async logic via a user-supplied function. */
export interface StepRunCode<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I> {
  kind: 'runCode';
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
export interface StepCallModel<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I> {
  kind: 'callModel';
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
   * the typed value at turn end). Non-Zod schemas can derive the model
   * constraint through StandardJSONSchemaV1 or provide `outputJsonSchema`.
   */
  output?: StandardSchemaV1<unknown, O> | OutputCodec<O>;
  /**
   * Explicit raw JSON Schema override sent to the model. For non-Zod schemas,
   * it takes precedence over StandardJSONSchemaV1 conversion.
   */
  outputJsonSchema?: Record<string, unknown>;
  params?: ModelParams;
  /** Controls framework event emission for this step. Defaults to `true`. Set `false` to suppress all framework events. A filter function receives `(eventType, data)` and returns `boolean`. */
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
  /** Projection policy for this step's context window. Overrides the harness-level default. */
  projection?: ProjectionPolicy;
}

/**
 * A step that delegates a turn to an external coding agent over the Agent
 * Client Protocol. One step kind serves every ACP-speaking agent — the agent
 * itself is supplied as an adapter, so the set of supported agents is open.
 * @public
 */
export interface StepAcpAgent<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I> {
  kind: 'acp-agent';
  id: string;
  /**
   * The ACP agent adapter that runs the turn. Eager or `(ctx) => AcpAgent`.
   * Programmatic builders take it inline; the JSON hydrator resolves it from
   * the workflow's agent registry and inlines it here.
   */
  agent: Lazy<AcpAgent, TContext>;
  /** Turn prompt as plain text. Eager string or `(ctx) => string` getter. */
  prompt?: Lazy<string, TContext>;
  /**
   * Full ACP prompt content — images, audio, resource links, embedded context.
   * Appended after `prompt` when both are given. Validated against the agent's
   * advertised `promptCapabilities` before the turn is sent.
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
  /** Declarative answer to the agent's permission requests. */
  permissions?: AcpPermissionPolicy;
  /** Async resolver consulted when policy and steering both abstain. */
  onPermissionRequest?: AcpPermissionHandler;
  /** Which client capabilities to advertise to the agent. */
  clientCapabilities?: AcpClientCapabilityConfig;
  /** When set, the assistant text is JSON-parsed and validated against this Standard Schema. */
  output?: StandardSchemaV1<unknown, O>;
  /** Session reuse + teardown policy across steps. */
  session?: AcpSessionPolicy;
  /** Controls framework event emission for this step. Defaults to `true`. */
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
}

/** @public A step that invokes a single tool directly, bypassing the model. */
export interface StepInvokeTool<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I> {
  kind: 'invokeTool';
  id: string;
  tool: Tool<StandardSchemaV1<unknown, I>, StandardSchemaV1<unknown, O>>;
  args?: Partial<I>;
}

/**
 * A step that asks a model typed questions about the current context and returns
 * typed answers with probabilities. It reads the conversation but never appends
 * to it, and runs no steering hooks. See spec 32.
 * @public
 */
export interface StepDecide<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I> {
  kind: 'decide';
  /** Phantom field carrying the answers type for inference. Never set at runtime. */
  readonly _answers?: O;
  id: string;
  /** Decision model id. Falls back to `harness.config.decisionModel`. */
  model?: Lazy<string, TContext>;
  /** Shared framing for every question. */
  instructions?: Lazy<string | undefined, TContext>;
  questions: DecideQuestions;
  /** Which part of the assembled view the model sees. */
  view: DecideView;
  /** Typed state read from context layers, sent as named state entries. */
  context?: (ctx: Context<TContext>) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Budget for the decision's view. Defaults to `DECISION_PROJECTION`. */
  projection?: ProjectionPolicy;
  /** Runs averaged on the estimated path. Ignored on the native path. */
  samples: number;
  /** Controls framework event emission for this step. Defaults to `true`. */
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
}

/**
 * A decide step that keeps its literal question map, so `routeSwitch` can infer
 * the questions, choices, and levels it routes by.
 * @public
 */
export type DecideStep<TContext, I, Q extends DecideQuestions> = StepDecide<
  TContext,
  I,
  DecideAnswers<Q>
> & {
  readonly questions: Q;
};

/**
 * What a decide step sees: `full` = layer recall + history, `layers` = layer
 * recall only, `none` = only the input, instructions, and context selector.
 * @public
 */
export type DecideView = 'full' | 'layers' | 'none';

/** @public A step that dynamically selects and executes one of several possible sub-steps. */
export interface StepConditional<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I> {
  kind: 'conditional';
  id: string;
  /**
   * Picks the step to run. `run` executes a step through the interpreter, for
   * routes that must run a step (such as a decision) to choose.
   */
  route: (
    input: I,
    ctx: Context<TContext>,
    run: ExecuteStepFn,
  ) => Step<TContext, I, O> | null | Promise<Step<TContext, I, O> | null>;
  _optimizable?: Step<TContext>[];
  /**
   * @internal Rebuild this step around new `_optimizable` children, for
   * conditionals whose route closes over them (`routeSwitch`). The optimizer calls
   * it so a mutated child is the one that runs.
   */
  _rebuild?: (children: Step<TContext>[]) => StepConditional<TContext, I, O>;
}

/** @public Union of inParallel step variants (`race`, `all`, `settle`) for concurrent path execution. */
export type StepInParallel<TContext = ContextData, I = unknown, O = unknown> =
  | StepInParallelRace<TContext, I, O>
  | StepInParallelAll<TContext, I, O>
  | StepInParallelSettle<TContext, I, O>;

/** @public An inParallel step that returns the result of the first path to complete. */
export interface StepInParallelRace<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I> {
  kind: 'inParallel';
  id: string;
  mode: 'race';
  paths: (input: I, ctx: Context<TContext>) => Step<TContext, I, O>[];
  concurrency?: number;
  _optimizable?: Step<TContext>[];
}

/** @public An inParallel step that runs all paths and merges their results. */
export interface StepInParallelAll<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I> {
  kind: 'inParallel';
  id: string;
  mode: 'all';
  paths: (input: I, ctx: Context<TContext>) => Step<TContext, I, O>[];
  merge: MergeFn<TContext, O>;
  concurrency?: number;
  _optimizable?: Step<TContext>[];
}

/** @public An inParallel step that runs all paths and collects fulfilled/rejected outcomes. */
export interface StepInParallelSettle<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I> {
  kind: 'inParallel';
  id: string;
  mode: 'settle';
  paths: (input: I, ctx: Context<TContext>) => Step<TContext, I, O>[];
  merge: MergeFn<TContext, O, SettleResult<O>>;
  concurrency?: number;
  _optimizable?: Step<TContext>[];
}

/**
 * A step that provides context layers to its child without creating an isolated context.
 * Like React's Context.Provider — layers are available to all descendant steps.
 * Spawn and detachedSpawn break the inheritance chain.
 * @public
 */
export interface StepWithContext<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I> {
  kind: 'withContext';
  id: string;
  child: Step<TContext, I, O>;
  context: ContextConfig | ContextLayer[];
}

/** @public A step that launches a child execution with its own context scope. */
export interface StepSpawn<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I> {
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
export interface StepLoop<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I> {
  kind: 'loop';
  /** Unique step identifier used in traces and error messages. */
  id: string;
  /** Steps to execute sequentially on each iteration. */
  steps: ReadonlyArray<Step<TContext, I, O>>;
  /**
   * Termination predicate evaluated after each iteration with a cumulative
   * snapshot — or a decide step asking one boolean question, run on the
   * iteration's output: yes stops the loop, no or a refusal continues it.
   */
  until: Until | StepDecide<TContext>;
  /**
   * Hard cap on iterations, retries included (default: 1000). Must be a positive
   * integer or `Infinity`; with `Infinity` only `until`, an error, or an abort
   * ends the loop.
   */
  maxIterations?: number;
  /** Maximum entries kept in the snapshot history array (default: 100); oldest drop first. */
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
 * Error policy for the `schedule` operator when its body step throws.
 * - `'continue'` (default): emit a span event recording the error and continue parking.
 * - `'fail'`: re-throw, terminating the operator.
 * @public
 */
export type ScheduleErrorPolicy = 'continue' | 'fail';

/**
 * A step that runs a body step on a fixed-interval schedule, optionally woken
 * sooner by an inbox channel. Runs forever until the executing context is cancelled.
 *
 * The operator output is `void` — `schedule` does not accumulate iteration outputs.
 * The `O` type parameter exists only to anchor the body step's output type.
 *
 * @public
 */
export interface StepSchedule<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I> {
  kind: 'schedule';
  /** Unique step identifier used in traces and error messages. */
  id: string;
  /** Body step executed on each iteration. */
  step: Step<TContext, I, O>;
  /** Park duration between iterations in milliseconds. Must be >= 0. */
  interval: number;
  /** Optional channel that wakes the parking interval when any value arrives. */
  inbox?: Channel<unknown>;
  /** Behavior when `step` throws. Defaults to `'continue'`. */
  onError?: ScheduleErrorPolicy;
  /** Random jitter applied to the park duration in milliseconds. Must be >= 0. Default 0. */
  jitter?: number;
}

/** @public Function signature used by the interpreter to recursively execute a step. */
export type ExecuteStepFn = <TContext, I, O>(
  step: Step<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
) => Promise<O>;
