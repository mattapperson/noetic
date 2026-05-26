import { NoeticConfigError } from '../errors/noetic-config-error';
import type { ContextMemory, MemoryConfig, MemoryLayer } from '../types/memory';
import type { Step, StepProvide } from '../types/step';
import { getDefaultRegistrar } from '../types/step-registrar';

/**
 * Creates a provide step that attaches memory layers to its child without creating an isolated context.
 * Like React's Context.Provider — layers are available to all descendant steps.
 * Spawn and detachedSpawn break the inheritance chain.
 *
 * @public
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.child - Step to execute with the provided layers.
 * @param opts.memory - Memory layers to provide to descendant steps.
 * @returns A `StepProvide` step.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `MISSING_CHILD_STEP` if `child` is not provided.
 */
export function provide<TMemory = ContextMemory, I = unknown, O = unknown>(opts: {
  id: string;
  child: Step<TMemory, I, O>;
  memory: MemoryConfig | MemoryLayer[];
}): StepProvide<TMemory, I, O> {
  if (!opts.id?.trim()) {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ID',
      message: 'provide() requires a non-empty id.',
      hint: 'Pass a unique string as the id field, e.g. provide({ id: "my-provider", ... }).',
    });
  }
  if (!opts.child) {
    throw new NoeticConfigError({
      code: 'MISSING_CHILD_STEP',
      message: 'provide() requires a child step.',
      hint: 'Provide a child step to execute with the provided memory layers.',
    });
  }
  const built: StepProvide<TMemory, I, O> = {
    kind: 'provide',
    ...opts,
  };
  getDefaultRegistrar().register(built);
  return built;
}
