import { NoeticConfigError } from '../errors/noetic-config-error';
import type { MemoryLayer } from '../types/memory';
import type { Step, StepSpawn } from '../types/step';

/**
 * Creates a spawn step that executes a child step in an isolated context boundary.
 *
 * @public
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.child - Step to execute in the isolated child context.
 * @param opts.memory - Optional memory layers for the child context (replaces parent layers entirely).
 * @param opts.timeout - Optional execution timeout in ms; the child is aborted if it exceeds this.
 * @returns A `StepSpawn` step.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `MISSING_CHILD_STEP` if `child` is not provided.
 */
export function spawn<I, O>(opts: {
  id: string;
  child: Step<I, O>;
  memory?: MemoryLayer[];
  timeout?: number;
}): StepSpawn<I, O> {
  if (!opts.id?.trim()) {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ID',
      message: 'spawn() requires a non-empty id.',
      hint: 'Pass a unique string as the id field, e.g. spawn({ id: "my-spawn", ... }).',
    });
  }
  if (!opts.child) {
    throw new NoeticConfigError({
      code: 'MISSING_CHILD_STEP',
      message: 'spawn() requires a child step.',
      hint: 'Provide a child step to execute in the isolated child context.',
    });
  }
  return {
    kind: 'spawn',
    ...opts,
  };
}
