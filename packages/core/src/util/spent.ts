import type { Context, UsageCharge } from '@noetic-tools/types';
import { recordUsage } from '@noetic-tools/types';

interface Spent {
  charge: UsageCharge;
  /** Runs once the charge lands on a context. */
  onCharge?: () => void;
}

/**
 * What a call had spent when it threw. A model call that fails after the provider
 * billed some of its rounds returns no `LLMResponse`, so the bill rides on the error
 * and the caller charges it. Kept beside the error rather than on it, so a provider
 * error keeps its own shape.
 */
const spends = new WeakMap<object, Spent>();

/**
 * Tie `charge` to `error` and return the error to throw. A charge the error already
 * carries — from a call nested inside this one that nobody charged — is added to.
 * A thrown value that is not an object is wrapped in an `Error` to carry the charge;
 * one that spent nothing is returned as is.
 */
export function markSpent(error: unknown, charge: UsageCharge, onCharge?: () => void): unknown {
  if (isEmpty(charge)) {
    return error;
  }
  const thrown = typeof error === 'object' && error !== null ? error : new Error(String(error));
  const prior = spends.get(thrown);
  spends.set(thrown, {
    charge: prior ? addCharges(prior.charge, charge) : charge,
    onCharge: () => {
      prior?.onCharge?.();
      onCharge?.();
    },
  });
  return thrown;
}

/**
 * Charge `ctx` with what the call behind `error` spent, and return that charge. The
 * mark is dropped once charged, so an error rethrown through an outer call is charged
 * only by that call.
 */
export function chargeSpent(ctx: Context, error: unknown): UsageCharge | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const spent = spends.get(error);
  if (!spent) {
    return undefined;
  }
  spends.delete(error);
  recordUsage(ctx, spent.charge);
  spent.onCharge?.();
  return spent.charge;
}

function isEmpty(charge: UsageCharge): boolean {
  return (
    charge.inputTokens === 0 &&
    charge.outputTokens === 0 &&
    !charge.cachedTokens &&
    !charge.cost &&
    !charge.billedCost
  );
}

function addCharges(a: UsageCharge, b: UsageCharge): UsageCharge {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.cachedTokens !== undefined || b.cachedTokens !== undefined
      ? {
          cachedTokens: (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0),
        }
      : {}),
    cost: (a.cost ?? 0) + (b.cost ?? 0),
    billedCost: (a.billedCost ?? a.cost ?? 0) + (b.billedCost ?? b.cost ?? 0),
  };
}
