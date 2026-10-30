import type { ContextConfig, ContextData, ContextLayer } from '@noetic-tools/context';
import type { StepEmitItems, StepReplay, Steps, StepWithContext } from '@noetic-tools/types';
import { NoeticConfigError } from '@noetic-tools/types';
import { getDefaultRegistrar } from '../types/step-registrar';
import { toStep } from './sequence';

export interface WithContextOpts<TContext, I, O>
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
  id: string;
  /** The child step, or an array of steps run in sequence. */
  child: Steps<TContext, I, O>;
  context: ContextConfig | ContextLayer[];
}

/**
 * Creates a provide step that attaches context layers to its child without creating an isolated context.
 * Like React's Context.Provider — layers are available to all descendant steps.
 * Spawn and detachedSpawn break the inheritance chain.
 *
 * @public
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.child - Step to execute with the provided layers.
 * @param opts.context - Context layers to provide to descendant steps.
 * @returns A `StepWithContext` step.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `MISSING_CHILD_STEP` if `child` is not provided.
 * @throws `NoeticConfigError` with code `MISSING_CONTEXT_LAYERS` if `context` is not provided.
 */
export function withContext<TContext = ContextData, I = unknown, O = unknown>(
  opts: WithContextOpts<TContext, I, O>,
): StepWithContext<TContext, I, O> {
  if (!opts.id?.trim()) {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ID',
      message: 'withContext() requires a non-empty id.',
      hint: 'Pass a unique string as the id field, e.g. withContext({ id: "my-provider", ... }).',
    });
  }
  if (!opts.child) {
    throw new NoeticConfigError({
      code: 'MISSING_CHILD_STEP',
      message: 'withContext() requires a child step.',
      hint: 'Provide a child step to execute with the provided context layers.',
    });
  }
  const layers = opts.context;
  if (!layers) {
    throw new NoeticConfigError({
      code: 'MISSING_CONTEXT_LAYERS',
      message: 'withContext() requires context layers.',
      hint: 'Pass context: [scratchpad()].',
    });
  }
  const built: StepWithContext<TContext, I, O> = {
    kind: 'withContext',
    id: opts.id,
    child: toStep(opts.child),
    context: layers,
    durable: opts.durable,
    replayKey: opts.replayKey,
  };
  getDefaultRegistrar().register(built);
  return built;
}
