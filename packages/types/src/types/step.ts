import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Claim, Constraint } from '../verify/ovp';
import type { VerifyClose, VerifyMatcher } from '../verify/verifier';
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
import type { ModelParams, RetryPolicy, ServerToolSpec, StepMeta, ToolChoice } from './common';
import type { ConnectionEvent, ConnectionHandle } from './connection';
import type { Context } from './context';
import type { ContextConfig, ContextData, ContextLayer, ProjectionPolicy } from './context-layer';
import type { CustomItem, CustomItemMap, CustomItemType } from './custom-item';
import type { DecideAnswers, DecideQuestions } from './decide';
import type { NoeticError } from './error';
import type { Item } from './items';
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
  /** USD held for cut-off paid calls with no settled bill — see `Context.heldCost`. */
  heldCost?: number;
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

/**
 * What an `emitItems` function gives: text, emitted as an assistant message; one item
 * or a list of items, appended as they are (any `Item`, including a custom extension
 * item the harness's item schemas accept); or `undefined` or `''` to emit nothing.
 * @public
 */
export type StepEmitItemsResult = string | Item | ReadonlyArray<Item> | undefined;

/**
 * Picks what a finished step emits from its output. Indexed out of a method so its
 * parameter stays bivariant, keeping a typed step assignable to the erased `Step` form.
 * @public
 */
export type StepEmitItemsFn<TContext = ContextData, O = unknown> = {
  bivariant(output: O, ctx: Context<TContext>): StepEmitItemsResult | Promise<StepEmitItemsResult>;
}['bivariant'];

/**
 * What an emit hook may return: the final value, or nothing, directly or through a
 * promise, or as a generator's return after it yields events. Mirrors a tool's
 * `execute`.
 * @public
 */
export type EmitHookResult<E, F> =
  | F
  | undefined
  | Promise<F | undefined>
  | Generator<E, F | undefined, undefined>
  | AsyncGenerator<E, F | undefined, undefined>;

/**
 * An `onStart`/`onDone` hook: a plain, async, generator, or async generator function.
 * Yields are events of the step's item; the return value is its final fields.
 * Indexed out of a method so its parameter stays bivariant.
 * @public
 */
export type EmitHook<TContext = ContextData, V = unknown, E = unknown, F = unknown> = {
  bivariant(value: V, ctx: Context<TContext>): EmitHookResult<E, F>;
}['bivariant'];

/** @public A hook for a step that names no custom item: it gives text or standard items. */
export type PlainEmitHook<TContext = ContextData, V = unknown> = {
  bivariant(value: V, ctx: Context<TContext>): StepEmitItemsResult | Promise<StepEmitItemsResult>;
}['bivariant'];

type ItemEvent<C> = C extends CustomItem<CustomItemType, infer E, unknown> ? E : never;
type ItemFields<C> = C extends CustomItem<CustomItemType, unknown, infer O> ? O : never;

/**
 * The hook form of `emitItems` (spec 34 § Emitting). Naming a declared `item` makes
 * the hooks yield its events and return its final fields, both typed by the item;
 * without one they give text or standard items.
 * @public
 */
export type StepEmitItemsConfig<
  TContext = ContextData,
  I = unknown,
  O = unknown,
  M extends CustomItemMap = CustomItemMap,
> =
  | {
      [N in keyof M & string]: {
        /** The declared item this step emits, by its name in scope. */
        item: N;
        /** Runs when the step starts, with its input. */
        onStart?: EmitHook<TContext, I, ItemEvent<M[N]>, ItemFields<M[N]>>;
        /** Runs when the step finishes, with its output. */
        onDone?: EmitHook<TContext, O, ItemEvent<M[N]>, ItemFields<M[N]>>;
      };
    }[keyof M & string]
  | {
      item?: undefined;
      onStart?: PlainEmitHook<TContext, I>;
      onDone?: PlainEmitHook<TContext, O>;
    };

/** @public What a step emits. See `StepEmitItems`. */
export type StepEmitItemsOption<
  TContext = ContextData,
  I = unknown,
  O = unknown,
  M extends CustomItemMap = CustomItemMap,
> = boolean | StepEmitItemsFn<TContext, O> | StepEmitItemsConfig<TContext, I, O, M>;

/**
 * Lets any step add items to the conversation as it runs, rather than only through
 * the workflow's final output, and declare custom items only it may emit.
 * @public
 */
export interface StepEmitItems<
  TContext = ContextData,
  I = unknown,
  O = unknown,
  M extends CustomItemMap = CustomItemMap,
> {
  /**
   * Emits items as the step runs: they are appended to the item log and streamed at
   * once (`item_appended`), so a step inside a loop emits on every iteration. `true`
   * emits the output as a final item: a string as an assistant message, an object
   * whose `type` names a custom item in scope as that item. A function picks text or
   * items. The hook form runs `onStart`/`onDone` and, naming an `item`, streams its
   * events. A replayed step emits again only under the harness's `emitItemsOnReplay`.
   */
  emitItems?: StepEmitItemsOption<TContext, I, O, M>;
  /** Custom items only this step may emit (spec 34). */
  customItems?: M;
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
  | StepSchedule<TContext, I, O>
  | StepCall<TContext, I, O>
  | StepWait<TContext, I, O>
  | StepVerify<TContext, I, O>;

/** @public A `runCode` body: async, or a generator that yields item events before returning. */
export type RunCodeExecute<TContext = ContextData, I = unknown, O = unknown> = (
  input: I,
  ctx: Context<TContext>,
) => Promise<O> | AsyncGenerator<unknown, O, undefined> | Generator<unknown, O, undefined>;

/** @public A step that executes arbitrary async logic via a user-supplied function. */
export interface StepRunCode<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
  kind: 'runCode';
  id: string;
  /**
   * The step's work. Like a tool's `execute`, it may be an async generator (or a
   * generator): its yields are events of the item `emitItems` names, its return value
   * the output.
   */
  execute: RunCodeExecute<TContext, I, O>;
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
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
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
   * How the model may use its tools: `'auto'` (default), `'required'`,
   * `'none'`, or `{ tool: name }` to force one client tool. Applies within the
   * `tools` restriction; see spec 02, Unified Tool Set.
   */
  toolChoice?: ToolChoice;
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
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
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
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
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
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
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
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
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
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
  kind: 'inParallel';
  id: string;
  mode: 'race';
  paths: (input: I, ctx: Context<TContext>) => Step<TContext, I, O>[];
  concurrency?: number;
  _optimizable?: Step<TContext>[];
}

/** @public An inParallel step that runs all paths and merges their results. */
export interface StepInParallelAll<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
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
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
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
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
  kind: 'withContext';
  id: string;
  child: Step<TContext, I, O>;
  context: ContextConfig | ContextLayer[];
}

/** @public A step that launches a child execution with its own context scope. */
export interface StepSpawn<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
  kind: 'spawn';
  id: string;
  child: Step<TContext, I, O>;
  context?: ContextConfig | ContextLayer[];
  timeout?: number;
  /**
   * Whether the child takes steers sent to the session while it runs.
   * `'hold'` (default) keeps them queued until control returns to the parent;
   * `'forward'` lets the child's model calls apply them.
   */
  steers?: 'forward' | 'hold';
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
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
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
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
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

//#region Connection steps

/**
 * The connection a `call` or `wait` step runs on: a handle from `connection()`,
 * a harness connection name, or a function of the step's input choosing one
 * (a JSON fan-out's `{ "$expr": "$item" }`). See spec 35.
 * @public
 */
export type StepConnectionTarget<TContext = ContextData, I = unknown> =
  | ConnectionHandle
  | string
  | ((
      input: I,
      ctx: Context<TContext>,
    ) => ConnectionHandle | string | Promise<ConnectionHandle | string>);

/**
 * A connection operation's arguments: a value, or a function of the step's input.
 * @public
 */
export type StepCallArgs<TContext = ContextData, I = unknown> =
  | Readonly<Record<string, unknown>>
  | ((input: I, ctx: Context<TContext>) => unknown);

/**
 * A step that runs one connection operation and returns its result (spec 35).
 * Operations that run long upstream are waited for automatically.
 * @public
 */
export interface StepCall<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
  kind: 'call';
  id: string;
  connection: StepConnectionTarget<TContext, I>;
  /** The operation, e.g. `ui.tap`. */
  op: string;
  args?: StepCallArgs<TContext, I>;
  /** Phantom field carrying the output type for inference. Never set at runtime. */
  readonly _output?: O;
}

/**
 * What a `wait` step returns: the event that matched, and the output of
 * `around` when it ran.
 * @public
 */
export interface StepWaitOutput<P = unknown, A = unknown> {
  event: ConnectionEvent<P>;
  around?: A;
}

/**
 * Decides whether an event ends a `wait`. Indexed out of a method so its parameters
 * stay bivariant, keeping a typed step assignable to the erased `Step` form.
 * @public
 */
export type StepWaitFilter<TContext = ContextData, I = unknown, P = unknown> = {
  bivariant(
    event: ConnectionEvent<P>,
    input: I,
    ctx: Context<TContext>,
  ): boolean | Promise<boolean>;
}['bivariant'];

/**
 * A step that waits for a connection event (spec 35). With `around`, it starts
 * listening, runs `around`, then waits, so the event an action causes cannot slip
 * past. Its output is `{ event, around }`.
 * @public
 */
export interface StepWait<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
  kind: 'wait';
  id: string;
  connection: StepConnectionTarget<TContext, I>;
  /** The event type, e.g. `chat.message.created`. */
  event: string;
  /** Picks the event that ends the wait; every event of the type matches without one. */
  filter?: StepWaitFilter<TContext, I>;
  /** A step, or an array of steps run in sequence, run once listening has started. */
  around?: Step<TContext, I, unknown> | ReadonlyArray<Step<TContext, I, unknown>>;
  /** How long to wait, in ms, from when listening starts. */
  timeoutMs: number;
  /** Phantom field carrying the output type for inference. Never set at runtime. */
  readonly _output?: O;
}

/**
 * The connection a `verify` checks — or a list, which runs one verify per
 * connection in parallel with ids `<id>.<name>` and the worst outcome (spec 37).
 * @public
 */
export type StepVerifySubject<TContext = ContextData, I = unknown> =
  | StepConnectionTarget<TContext, I>
  | ReadonlyArray<ConnectionHandle | string>;

/**
 * @public
 * A verify's action: a step, an array of steps run in sequence, or a function
 * of the subject's connection name giving them — the way to act on each
 * subject of a list subject (spec 37 § Writing a verify).
 */
export type StepVerifyAct<TContext = ContextData, I = unknown> =
  | Step<TContext, I, unknown>
  | ReadonlyArray<Step<TContext, I, unknown>>
  | ((subject: string) => Step<TContext, I, unknown> | ReadonlyArray<Step<TContext, I, unknown>>);

/**
 * A step that checks claims about what a connection shows (spec 37): it
 * declares what should become true, runs `act`, watches the connection's
 * senses, and answers with OVP verdicts and the gaps it could not see. Its
 * output's `outcome` is `pass`, `fail`, `partial` or `unknown`. Built by
 * `step.verify`; judged by the harness's registered verifier.
 * @public
 */
export interface StepVerify<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
  kind: 'verify';
  id: string;
  subject: StepVerifySubject<TContext, I>;
  /** What must become true; each entry lowers to an OVP claim. Exactly one of `expect` or `claims`. */
  expect?: ReadonlyArray<VerifyMatcher>;
  /** What must not happen while `act` runs; each entry lowers to a blocking OVP constraint. */
  never?: ReadonlyArray<VerifyMatcher>;
  /** OVP claims given directly, instead of `expect`. */
  claims?: ReadonlyArray<Claim>;
  /** OVP constraints given directly, instead of `never`. */
  constraints?: ReadonlyArray<Constraint>;
  /**
   * The action: a step, or an array of steps run in sequence — or, for a list
   * subject, a function of each subject's connection name giving its action.
   */
  act: StepVerifyAct<TContext, I>;
  /** Connections that can look and cannot touch, confirming from outside the subject. */
  witnesses?: ReadonlyArray<ConnectionHandle | string>;
  /** When to stop watching. Default: quiet for 500 ms, at most 15 s. */
  close?: VerifyClose;
  /** A sentence saying why, kept in the run record. */
  intent?: string;
  /** Phantom field carrying the output type for inference. Never set at runtime. */
  readonly _output?: O;
}

//#endregion
