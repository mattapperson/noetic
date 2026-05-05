import { NoeticConfigError } from '../errors/noetic-config-error';
import { getDefaultRegistrar } from '../types/step-registrar';
import type { ContextMemory, MemoryConfig, MemoryLayer } from '../types/memory';
import type { Step, StepSpawn } from '../types/step';
import type { SubprocessAdapter } from '../types/subprocess-adapter';

//#region Types

interface SpawnOpts<TMemory, I, O> {
  id: string;
  child: Step<TMemory, I, O>;
  memory?: MemoryConfig | MemoryLayer[];
  timeout?: number;
  /**
   * Optional per-step subprocess adapter override. The interpreter routes
   * this spawn through the given adapter instead of the harness default.
   * See spec 04 for the `overrides ?? step ?? harness` precedence rule.
   */
  subprocess?: SubprocessAdapter;
}

//#endregion

//#region Public API

/**
 * Creates a spawn step that executes a child step in an isolated context boundary.
 *
 * @public
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.child - Step to execute in the isolated child context.
 * @param opts.memory - Optional memory config or layers for the child context (replaces parent layers entirely).
 * @param opts.timeout - Optional execution timeout in ms; the child is aborted if it exceeds this.
 * @param opts.subprocess - Optional per-step subprocess adapter override.
 * @returns A `StepSpawn` step. The spawn step and its `child` step are both
 *   auto-registered in the shared step registry so the subprocess adapter
 *   can dispatch either by id.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `MISSING_CHILD_STEP` if `child` is not provided.
 * @throws `NoeticConfigError` with code `DUPLICATE_STEP_ID` if another step with the same id is already registered.
 */
export function spawn<TMemory = ContextMemory, I = unknown, O = unknown>(
  opts: SpawnOpts<TMemory, I, O>,
): StepSpawn<TMemory, I, O> {
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
  const built: StepSpawn<TMemory, I, O> = {
    kind: 'spawn',
    ...opts,
  };
  getDefaultRegistrar().register(built);
  // Ensure the child is addressable by id — builders for `run`/`llm`/`tool`
  // self-register, but a caller can construct a step literal and pass it as
  // `child` without going through a builder.
  getDefaultRegistrar().register(opts.child);
  return built;
}

//#endregion
