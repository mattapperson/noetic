import type { Context } from '../types/context';
import type { Step, StepForkRace, StepForkAll, StepForkSettle, SettleResult } from '../types/step';

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
  return { kind: 'fork', ...opts };
}
