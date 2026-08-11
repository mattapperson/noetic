import type { ContextConfig, ContextData, ContextLayer } from '@noetic-tools/context';
import type { Step, StepProvide } from '@noetic-tools/types';
import { NoeticConfigError } from '@noetic-tools/types';
import { getDefaultRegistrar } from '../types/step-registrar';

/**
 * Creates a provide step that attaches context layers to its child without creating an isolated context.
 * Like React's Context.Provider — layers are available to all descendant steps.
 * Spawn and detachedSpawn break the inheritance chain.
 *
 * @public
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.child - Step to execute with the provided layers.
 * @param opts.context - Context layers to provide to descendant steps.
 * @returns A `StepProvide` step.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `MISSING_CHILD_STEP` if `child` is not provided.
 */
export function provide<TContext = ContextData, I = unknown, O = unknown>(opts: {
  id: string;
  child: Step<TContext, I, O>;
  context: ContextConfig | ContextLayer[];
}): StepProvide<TContext, I, O> {
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
      hint: 'Provide a child step to execute with the provided context layers.',
    });
  }
  const layers = opts.context;
  if (!layers) {
    throw new NoeticConfigError({
      code: 'MISSING_CONTEXT_LAYERS',
      message: 'provide() requires context layers.',
      hint: 'Pass context: [workingMemoryContext()].',
    });
  }
  const built: StepProvide<TContext, I, O> = {
    kind: 'provide',
    id: opts.id,
    child: opts.child,
    context: layers,
  };
  getDefaultRegistrar().register(built);
  return built;
}
