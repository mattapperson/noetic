/**
 * Harness state that core modules share but that must never be reachable from
 * the harness object itself: anything holding `ctx.harness` (a tool, a step, a
 * context layer) could otherwise cast its way to the connection registry and
 * drive a connection around the gates. The store is keyed by harness and is
 * not exported from any package entry point.
 */

import { frameworkCast } from '@noetic-tools/types';

//#region Types

/** The internal slots a harness fills when it is constructed. */
export interface HarnessInternalSlots {
  /** The connection registry steps and tools resolve connections through (spec 35). */
  connectionRegistry: unknown;
  /** The verifier `step.verify` uses (spec 37). */
  verifier: unknown;
}

type HarnessInternalKey = keyof HarnessInternalSlots;

//#endregion

//#region Store

const INTERNALS = new WeakMap<object, Partial<HarnessInternalSlots>>();

//#endregion

//#region Public API

/** Records internal slots of a harness, merged over any it already has. */
export function setHarnessInternals(harness: object, slots: Partial<HarnessInternalSlots>): void {
  INTERNALS.set(harness, {
    ...INTERNALS.get(harness),
    ...slots,
  });
}

/**
 * Reads one internal slot of a harness, typed by the caller (the slot's owner
 * sits in a higher layer than this module, so the type is supplied, not imported).
 */
export function harnessInternal<T>(harness: unknown, key: HarnessInternalKey): T | undefined {
  if (typeof harness !== 'object' || harness === null) {
    return undefined;
  }
  const value = INTERNALS.get(harness)?.[key];
  if (value === undefined) {
    return undefined;
  }
  return frameworkCast<T>(value);
}

//#endregion
