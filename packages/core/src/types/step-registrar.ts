/**
 * `StepRegistrar` is the layer-safe indirection that lets builders
 * (in `core-primitives`) register steps without importing the runtime
 * registry directly (which lives in `core-runtime`, a lower layer).
 *
 * The runtime provides the concrete implementation via
 * `setDefaultRegistrar()` on module load. Until then a no-op fallback
 * is active so builders constructed outside a harness (e.g. in unit
 * tests that never touch the interpreter) don't throw.
 *
 * The registry itself lives in `packages/core/src/runtime/step-registry.ts`
 * and is consulted only by `packages/core/src/harness/step-bootstrap.ts`
 * when an out-of-process child needs to look up a step by id. In-process
 * execution walks the step tree directly and never touches either side.
 */

import type { Step } from './step';

//#region Types

/**
 * @public
 * Registers a step under its `id` so the subprocess adapter can later
 * look it up by name from an out-of-process child. Implementations
 * typically call the runtime's underlying `registerStep` function.
 */
export interface StepRegistrar {
  register<TMemory, I, O>(step: Step<TMemory, I, O>): void;
}

//#endregion

//#region Module state

/**
 * No-op registrar used until the runtime installs the real one. Keeps
 * builder-only callsites (e.g. tests that construct a step without
 * instantiating `AgentHarness`) non-throwing.
 */
const noopRegistrar: StepRegistrar = {
  register: () => undefined,
};

let currentRegistrar: StepRegistrar = noopRegistrar;

//#endregion

//#region Public API

/**
 * @public
 * Returns the active registrar. Called by every step builder to register
 * the step it just constructed. Default is a no-op; the runtime installs
 * the real implementation via `setDefaultRegistrar()` on module load.
 */
export function getDefaultRegistrar(): StepRegistrar {
  return currentRegistrar;
}

/**
 * @public
 * Installs a registrar implementation. Called exactly once by the
 * runtime on module load; tests that want per-case isolation can
 * install a throwing or counting registrar and restore the default
 * with `resetDefaultRegistrar()` in their teardown.
 */
export function setDefaultRegistrar(registrar: StepRegistrar): void {
  currentRegistrar = registrar;
}

/**
 * @public
 * Restores the no-op registrar. Primarily a test helper — production
 * code paths rely on the runtime having installed the real registrar.
 */
export function resetDefaultRegistrar(): void {
  currentRegistrar = noopRegistrar;
}

//#endregion
