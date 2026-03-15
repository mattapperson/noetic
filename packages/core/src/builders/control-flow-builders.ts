import type { Context } from '../types/context';
import type { Step, StepBranch, StepForkRace, StepForkAll, StepForkSettle, SettleResult } from '../types/step';

// Fork builder with overloads for type safety
export function fork<I, O>(opts: {
  id: string;
  mode: 'race';
  paths: (input: I, ctx: Context) => Step<I, O>[];
  concurrency?: number;
}): StepForkRace<I, O>;

export function fork<I, O>(opts: {
  id: string;
  mode: 'all';
  paths: (input: I, ctx: Context) => Step<I, O>[];
  merge: (results: O[], ctx: Context) => O;
  concurrency?: number;
}): StepForkAll<I, O>;

export function fork<I, O>(opts: {
  id: string;
  mode: 'settle';
  paths: (input: I, ctx: Context) => Step<I, O>[];
  merge: (results: SettleResult<O>[], ctx: Context) => O;
  concurrency?: number;
}): StepForkSettle<I, O>;

export function fork<I, O>(opts: any): any {
  if (!opts.id || opts.id.trim() === '') throw new Error('fork requires a non-empty id');
  if ((opts.mode === 'all' || opts.mode === 'settle') && !opts.merge) {
    throw new Error(`fork mode '${opts.mode}' requires a merge function`);
  }
  return { kind: 'fork', ...opts };
}

export function branch<I, O>(opts: {
  id: string;
  route: (input: I, ctx: Context) => Step<I, O> | null;
}): StepBranch<I, O> {
  if (!opts.id || opts.id.trim() === '') throw new Error('branch requires a non-empty id');
  if (!opts.route) throw new Error('branch requires a route function');
  return { kind: 'branch', ...opts };
}
