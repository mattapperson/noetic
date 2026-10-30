import type { ContextConfig, ContextData, ContextLayer } from '@noetic-tools/context';
import type {
  StepEmitItems,
  StepReplay,
  StepSpawn,
  Steps,
  SubprocessAdapter,
} from '@noetic-tools/types';
import { NoeticConfigError } from '@noetic-tools/types';
import { getDefaultRegistrar } from '../types/step-registrar';
import { toStep } from './sequence';

//#region Types

/**
 * Options for {@link spawn}.
 *
 * @public
 */
export interface SpawnOpts<TContext = ContextData, I = unknown, O = unknown>
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, O> {
  id: string;
  /** The child step, or an array of steps run in sequence. */
  child: Steps<TContext, I, O>;
  context?: ContextConfig | ContextLayer[];
  timeout?: number;
  /**
   * Whether the child takes steers sent to the session while it runs.
   * `'hold'` (default) keeps them queued until control returns to the parent;
   * `'forward'` lets the child's model calls apply them.
   */
  steers?: 'forward' | 'hold';
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
 * @param opts.context - Optional context config or layers for the child context (replaces parent layers entirely).
 * @param opts.timeout - Optional execution timeout in ms; the child is aborted if it exceeds this.
 * @param opts.steers - `'forward'` lets the child apply steers sent while it runs; default `'hold'`.
 * @param opts.subprocess - Optional per-step subprocess adapter override.
 * @returns A `StepSpawn` step. The spawn step and its `child` step are both
 *   auto-registered in the shared step registry so the subprocess adapter
 *   can dispatch either by id.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `MISSING_CHILD_STEP` if `child` is not provided.
 */
export function spawn<TContext = ContextData, I = unknown, O = unknown>(
  opts: SpawnOpts<TContext, I, O>,
): StepSpawn<TContext, I, O> {
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
  const built: StepSpawn<TContext, I, O> = {
    kind: 'spawn',
    id: opts.id,
    child: toStep(opts.child),
    context: opts.context,
    timeout: opts.timeout,
    steers: opts.steers,
    subprocess: opts.subprocess,
    durable: opts.durable,
    replayKey: opts.replayKey,
  };
  getDefaultRegistrar().register(built);
  // Ensure the child is addressable by id — builders for `runCode`/`callModel`/`invokeTool`
  // self-register, but a caller can construct a step literal and pass it as
  // `child` without going through a builder.
  getDefaultRegistrar().register(built.child);
  return built;
}

//#endregion
