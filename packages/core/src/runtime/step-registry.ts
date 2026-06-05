import type { ContextMemory } from '@noetic-tools/memory';
import type { Step } from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import { setDefaultRegistrar } from '../types/step-registrar';

//#region Types

/** Registry-wide step type — stored at the widest generic parameters so
 *  callers can register steps with narrower input/output types without
 *  fighting variance. The public `Step` default already uses `unknown` for
 *  the input and output parameters, matching this shape. */
type RegisteredStep = Step<ContextMemory, unknown, unknown>;

//#endregion

//#region Module state

const registry = new Map<string, RegisteredStep>();

//#endregion

//#region Public API

/**
 * @public
 * Registers a step so the subprocess adapter can look it up by id.
 *
 * Called automatically by the step builders when a `Step` is constructed.
 * Policy: **latest registration wins**. Dispatch-and-lookup happen in the
 * same tick, so the live entry is always the one the caller just built;
 * cross-test pollution from bun's per-file process model (describe blocks
 * rebuild the same step id) is not a safety concern here. Strict
 * "reject duplicate id with a different body" detection + a test-side
 * `clearRegistry` wiring is deferred — see the tracked follow-up task on
 * the team's board (strict-registry-plus-test-clear).
 */
export function registerStep<TMemory, I, O>(step: Step<TMemory, I, O>): void {
  if (!step.id || step.id.trim() === '') {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ID',
      message: 'registerStep() requires a step with a non-empty id.',
      hint: 'Set `id` on the step before constructing it.',
    });
  }
  // `frameworkCast` is the approved single-point escape for generic variance:
  // narrowing I/O from specific types to the registry's widened `unknown`
  // shape is structurally safe at runtime because the registry only holds
  // references and dispatches them through the same `execute()` pipeline.
  const widened = frameworkCast<RegisteredStep>(step);
  registry.set(step.id, widened);
}

/**
 * @public
 * Looks up a registered step by id. Returns `null` when the id is not known
 * — callers (e.g. the in-memory adapter's step dispatch path) translate the
 * miss into a typed configuration error.
 */
export function lookupStep(id: string): RegisteredStep | null {
  return registry.get(id) ?? null;
}

/**
 * @public
 * Returns a read-only view over the registry. Primarily for tests and
 * debugging; production callers should use `lookupStep`.
 */
export function getRegistry(): ReadonlyMap<string, RegisteredStep> {
  return registry;
}

/**
 * @public
 * Clears the registry. Test-only helper — exported because several suites
 * need a clean registry between describe blocks. Not part of the public API
 * surface consumed by agent authors.
 */
export function clearRegistry(): void {
  registry.clear();
}

//#endregion

//#region Default-registrar installation

/**
 * Install this module's `registerStep` as the runtime default registrar.
 * Executes on first import — which happens transitively from
 * `agent-harness.ts` and from anywhere that imports `@noetic-tools/core`'s
 * top-level barrel. Builders call `getDefaultRegistrar().register(step)`
 * from `../types/step-registrar` and get this concrete implementation
 * without depending on `core-runtime` themselves (fixes the
 * `core-primitives → core-runtime` layer_direction violations).
 */
setDefaultRegistrar({
  register: registerStep,
});

//#endregion
