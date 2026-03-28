import type { ZodType } from 'zod';
import type { Channel } from './channel';
import type { ModelParams, RetryPolicy, StepMeta, Tool } from './common';
import type { Context } from './context';
import type { NoeticError } from './error';
import type { MemoryLayer } from './memory';

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
export type Step<I = unknown, O = unknown> =
  | StepRun<I, O>
  | StepLLM<I, O>
  | StepTool<I, O>
  | StepBranch<I, O>
  | StepFork<I, O>
  | StepSpawn<I, O>
  | StepLoop<I, O>;

/** @public A step that executes arbitrary async logic via a user-supplied function. */
export interface StepRun<I, O> {
  kind: 'run';
  id: string;
  execute: (input: I, ctx: Context) => Promise<O>;
  retry?: RetryPolicy;
}

/** @public A step that sends a prompt to a language model and returns its response. */
export interface StepLLM<_I, O> {
  kind: 'llm';
  id: string;
  model: string;
  system?: string;
  tools?: Tool[];
  output?: ZodType<O>;
  params?: ModelParams;
}

/** @public A step that invokes a single tool directly, bypassing the LLM. */
export interface StepTool<I, O> {
  kind: 'tool';
  id: string;
  tool: Tool<ZodType<I>, ZodType<O>>;
  args?: Partial<I>;
}

/** @public A step that dynamically selects and executes one of several possible sub-steps. */
export interface StepBranch<I, O> {
  kind: 'branch';
  id: string;
  route: (input: I, ctx: Context) => Step<I, O> | null | Promise<Step<I, O> | null>;
  _optimizable?: Step[];
}

/** @public Union of fork step variants (`race`, `all`, `settle`) for concurrent path execution. */
export type StepFork<I, O> = StepForkRace<I, O> | StepForkAll<I, O> | StepForkSettle<I, O>;

/** @public A fork step that returns the result of the first path to complete. */
export interface StepForkRace<I, O> {
  kind: 'fork';
  id: string;
  mode: 'race';
  paths: (input: I, ctx: Context) => Step<I, O>[];
  concurrency?: number;
  _optimizable?: Step[];
}

/** @public A fork step that runs all paths and merges their results. */
export interface StepForkAll<I, O> {
  kind: 'fork';
  id: string;
  mode: 'all';
  paths: (input: I, ctx: Context) => Step<I, O>[];
  merge: (results: O[], ctx: Context) => O;
  concurrency?: number;
  _optimizable?: Step[];
}

/** @public A fork step that runs all paths and collects fulfilled/rejected outcomes. */
export interface StepForkSettle<I, O> {
  kind: 'fork';
  id: string;
  mode: 'settle';
  paths: (input: I, ctx: Context) => Step<I, O>[];
  merge: (results: SettleResult<O>[], ctx: Context) => O;
  concurrency?: number;
  _optimizable?: Step[];
}

/** @public A step that launches a child execution with its own memory scope. */
export interface StepSpawn<I, O> {
  kind: 'spawn';
  id: string;
  child: Step<I, O>;
  memory?: MemoryLayer[];
  timeout?: number;
}

/**
 * A loop step that iterates a body step until a termination predicate is satisfied.
 * @public
 */
export interface StepLoop<I, O> {
  kind: 'loop';
  /** Unique step identifier used in traces and error messages. */
  id: string;
  /** Steps to execute sequentially on each iteration. */
  steps: ReadonlyArray<Step<I, O>>;
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
  prepareNext?: (output: O, verdict: Verdict, ctx: Context) => I;
  /** Per-iteration error handler: retry the iteration, skip it, or abort the loop. */
  onError?: (error: NoeticError, ctx: Context) => 'retry' | 'skip' | 'abort';
}

/** @public Function signature used by the interpreter to recursively execute a step. */
export type ExecuteStepFn = <I, O>(step: Step<I, O>, input: I, ctx: Context) => Promise<O>;
