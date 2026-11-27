/**
 * Errors that end the whole turn, whichever step they surface in (spec 23
 * § Versions, § One writer per turn). A step that retries, wraps, collects or
 * skips its children's errors must let these through as they are: the harness
 * reads the kind to know why the turn stopped, and a retry could not help.
 */

import type { NoeticError, TurnCutReason } from '@noetic-tools/types';
import { isNoeticError, NoeticErrorImpl } from '@noetic-tools/types';
import { TURN_CUT_ABORT } from '../runtime/durable/parking';

/** @internal The kinds that end a turn. */
export const TURN_ENDING_KINDS: ReadonlySet<string> = new Set([
  'turn_stuck',
  'lease_lost',
  'ledger_write_failed',
  'acp_link_lost',
  'acp_outcome_unknown',
  'connection_outcome_unknown',
  'subprocess_outcome_unknown',
]);

function endingIn(error: NoeticError): NoeticError | undefined {
  if (TURN_ENDING_KINDS.has(error.kind)) {
    return error;
  }
  if (error.kind === 'fork_partial') {
    for (const failure of error.failed) {
      const found = endingIn(failure.error);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (error.kind === 'step_failed') {
    return isNoeticError(error.cause) ? endingIn(error.cause.noeticError) : undefined;
  }
  return undefined;
}

/**
 * @internal
 * The turn-ending error inside `error`, when there is one: `error` itself, the
 * cause of a `step_failed`, or a path's failure folded into a `fork_partial`.
 */
export function turnEndingIn(error: unknown): NoeticErrorImpl | undefined {
  if (!isNoeticError(error)) {
    return undefined;
  }
  const found = endingIn(error.noeticError);
  if (!found) {
    return undefined;
  }
  return found === error.noeticError ? error : new NoeticErrorImpl(found);
}

/** A cut is an interruption the harness can resume from its ledger. */
export function cutReasonOf(error: unknown): TurnCutReason | undefined {
  const failure = turnEndingIn(error)?.noeticError;
  switch (failure?.kind) {
    case 'lease_lost':
    case 'ledger_write_failed':
    case 'acp_link_lost':
      return failure.kind;
    case 'connection_outcome_unknown':
      return failure.retry === undefined ? undefined : failure.kind;
  }
}

/** Leave live external work for the next owner when its sibling cuts the turn. */
export function recoverableAbort(error: unknown, fallback: string): string {
  return cutReasonOf(error) ? TURN_CUT_ABORT : fallback;
}
