import type { MemoryLayer } from '../types/memory';
import type { Step, StepSpawn } from '../types/step';

/**
 * Creates a spawn step that executes a child step in an isolated context boundary.
 *
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.child - Step to execute in the isolated child context.
 * @param opts.memory - Optional memory layers for the child context (replaces parent layers entirely).
 * @param opts.timeout - Optional execution timeout in ms; the child is aborted if it exceeds this.
 * @returns A `StepSpawn` step.
 */
export function spawn<I, O>(opts: {
  id: string;
  child: Step<I, O>;
  memory?: MemoryLayer[];
  timeout?: number;
}): StepSpawn<I, O> {
  if (!opts.id || !opts.id.trim()) {
    throw new Error('spawn() requires a non-empty id');
  }
  if (!opts.child) {
    throw new Error('spawn() requires a child step');
  }
  return {
    kind: 'spawn',
    ...opts,
  };
}
