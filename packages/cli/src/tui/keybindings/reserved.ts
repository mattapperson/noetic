import type { Action } from './actions.js';
import { ACTIONS } from './actions.js';

/**
 * Actions whose bindings cannot be customised. Calling
 * `KeybindingRegistry.setBinding` with one of these throws.
 *
 * Ctrl+C is reserved because the safety net assumes a single, predictable
 * trigger; rebinding it would let a user lock themselves out of cancel.
 */
export const RESERVED_ACTIONS: ReadonlySet<Action> = new Set([
  ACTIONS.AppInterrupt,
]);
