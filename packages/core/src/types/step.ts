import type { ZodType } from 'zod';
import type { ModelParams, RetryPolicy, StepMeta, Tool } from './common';
import type { Context } from './context';
import type { NoeticError } from './error';
import type { Item } from './items';

// Until predicate types
export interface Snapshot {
  stepCount: number;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  elapsed: number;
  cost: number;
  lastOutput: unknown;
  lastText: string;
  history: unknown[];
  depth: number;
  lastStepMeta?: StepMeta | null;
}

export interface Verdict {
  stop: boolean;
  reason?: string;
  feedback?: string;
}

export type Until = (snapshot: Snapshot) => Verdict | Promise<Verdict>;

// Context strategies for spawn
export type ContextInStrategy =
  | {
      strategy: 'inherit';
    }
  | {
      strategy: 'fresh';
    }
  | {
      strategy: 'subset';
      select: (parentItems: Item[], parentState: unknown) => Item[];
    }
  | {
      strategy: 'custom';
      build: (input: unknown, parentCtx: Context) => Item[];
    };

export type ContextOutStrategy<O> =
  | {
      strategy: 'full';
    }
  | {
      strategy: 'summary';
      model?: string;
      prompt?: string;
    }
  | {
      strategy: 'schema';
      schema: ZodType<O>;
    };

// Settle result for fork
export interface SettleResult<O> {
  stepId: string;
  status: 'fulfilled' | 'rejected';
  value?: O;
  error?: NoeticError;
}

// The main Step discriminated union
export type Step<I = unknown, O = unknown> =
  | StepRun<I, O>
  | StepLLM<I, O>
  | StepTool<I, O>
  | StepBranch<I, O>
  | StepFork<I, O>
  | StepSpawn<I, O>
  | StepLoop<I, O>;

export interface StepRun<I, O> {
  kind: 'run';
  id: string;
  execute: (input: I, ctx: Context) => Promise<O>;
  retry?: RetryPolicy;
}

export interface StepLLM<_I, O> {
  kind: 'llm';
  id: string;
  model: string;
  system?: string;
  tools?: Tool[];
  output?: ZodType<O>;
  params?: ModelParams;
}

export interface StepTool<I, O> {
  kind: 'tool';
  id: string;
  tool: Tool<ZodType<I>, ZodType<O>>;
  args?: Partial<I>;
}

export interface StepBranch<I, O> {
  kind: 'branch';
  id: string;
  route: (input: I, ctx: Context) => Step<I, O> | null;
}

// Fork with type-safe mode variants
export type StepFork<I, O> = StepForkRace<I, O> | StepForkAll<I, O> | StepForkSettle<I, O>;

export interface StepForkRace<I, O> {
  kind: 'fork';
  id: string;
  mode: 'race';
  paths: (input: I, ctx: Context) => Step<I, O>[];
  concurrency?: number;
}

export interface StepForkAll<I, O> {
  kind: 'fork';
  id: string;
  mode: 'all';
  paths: (input: I, ctx: Context) => Step<I, O>[];
  merge: (results: O[], ctx: Context) => O;
  concurrency?: number;
}

export interface StepForkSettle<I, O> {
  kind: 'fork';
  id: string;
  mode: 'settle';
  paths: (input: I, ctx: Context) => Step<I, O>[];
  merge: (results: SettleResult<O>[], ctx: Context) => O;
  concurrency?: number;
}

export interface StepSpawn<I, O> {
  kind: 'spawn';
  id: string;
  child: Step<I, O>;
  contextIn: ContextInStrategy;
  contextOut: ContextOutStrategy<O>;
  timeout?: number;
}

export interface StepLoop<I, O> {
  kind: 'loop';
  id: string;
  body: Step<I, O>;
  until: Until;
  maxIterations?: number;
  maxHistorySize?: number;
  prepareNext?: (output: O, verdict: Verdict, ctx: Context) => I;
  onError?: (error: NoeticError, ctx: Context) => 'retry' | 'skip' | 'abort';
}

export type ExecuteStepFn = <I, O>(step: Step<I, O>, input: I, ctx: Context) => Promise<O>;
