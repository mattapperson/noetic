import type { Context, UsageCharge } from '@noetic-tools/types';
import { recordUsage } from '@noetic-tools/types';

/**
 * What a call had spent when it threw. A model call that fails after the provider
 * billed some of its rounds returns no `LLMResponse`, so the bill rides on the error
 * and the caller charges it. Kept beside the error rather than on it, so a provider
 * error keeps its own shape.
 */
const spends = new WeakMap<object, UsageCharge>();

/**
 * Tie `charge` to `error` and return the error to throw. A thrown value that is not
 * an object is wrapped in an `Error`, which can carry the charge.
 */
export function markSpent(error: unknown, charge: UsageCharge): unknown {
  const thrown = typeof error === 'object' && error !== null ? error : new Error(String(error));
  spends.set(thrown, charge);
  return thrown;
}

/**
 * Charge `ctx` with what the call behind `error` spent. The mark is dropped once
 * charged, so an error rethrown through an outer call is charged only by that call.
 */
export function chargeSpent(ctx: Context, error: unknown): void {
  if (typeof error !== 'object' || error === null) {
    return;
  }
  const charge = spends.get(error);
  if (!charge) {
    return;
  }
  spends.delete(error);
  recordUsage(ctx, charge);
}
