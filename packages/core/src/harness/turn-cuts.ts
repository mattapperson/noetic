/**
 * Cut turns (spec 23 § Cut turns) keep their ledger and pending entries.
 * A wake resumes after a back-off. The harness keeps the mark in memory too,
 * in case storage refuses it.
 */

import { NoeticConfigError } from '@noetic-tools/types';
import { cutReasonOf } from '../interpreter/turn-ending';
import type { TurnCutReason } from './deps/types';
import type { TurnCutConfig } from './harness-options';

//#region Types

/** How often a turn was cut, and when last. */
export interface CutMark {
  readonly reason: string;
  readonly count: number;
  readonly at: number;
}

/**
 * The parts of a stored turn a cut is read from. A turn is known by its messages,
 * not its execution: one whose checkpoint could not be written resumes under a
 * new execution id, and its cuts still count.
 */
interface CutTurn {
  readonly messageIds: ReadonlyArray<string>;
  readonly cut?: CutMark;
}

interface CutPolicy {
  readonly attempts: number;
  readonly delayMs: number;
  readonly maxDelayMs: number;
}

//#endregion

//#region Constants

/** @public How many times a turn may be cut and run again before it fails. */
export const DEFAULT_CUT_ATTEMPTS = 3;

/** @public How long after its first cut a turn is due again, in ms. */
export const DEFAULT_CUT_DELAY_MS = 1e3;

/** @public The longest a cut turn waits before it is due again, in ms. */
export const DEFAULT_CUT_MAX_DELAY_MS = 6e4;

//#endregion

//#region Helpers

/** What names a turn's delivery: its message ids, in order. */
function deliveryOf(turn: CutTurn): string {
  return JSON.stringify(turn.messageIds);
}

function resolveCutPolicy(config: TurnCutConfig | undefined): CutPolicy {
  const attempts = config?.attempts ?? DEFAULT_CUT_ATTEMPTS;
  const delayMs = config?.delayMs ?? DEFAULT_CUT_DELAY_MS;
  const maxDelayMs = config?.maxDelayMs ?? DEFAULT_CUT_MAX_DELAY_MS;
  const attemptsOk = Number.isInteger(attempts) && attempts >= 0;
  const delayOk = Number.isFinite(delayMs) && delayMs >= 0;
  const maxOk = Number.isFinite(maxDelayMs) && maxDelayMs >= delayMs;
  if (!attemptsOk || !delayOk || !maxOk) {
    throw new NoeticConfigError({
      code: 'INVALID_LEASE_OPTIONS',
      message: `environment.storage.lease.cut is not usable: attempts ${attempts}, delayMs ${delayMs}, maxDelayMs ${maxDelayMs}.`,
      hint: 'Give attempts a whole number from 0 up, delayMs a finite number from 0 up, and maxDelayMs a finite number no less than delayMs, or leave them out for the defaults.',
    });
  }
  return {
    attempts,
    delayMs,
    maxDelayMs,
  };
}

//#endregion

//#region TurnCuts

/** @internal The harness's cut marks, by thread, and the policy that runs cut turns again. */
export class TurnCuts {
  private readonly policy: CutPolicy;
  private readonly marks = new Map<
    string,
    CutMark & {
      readonly delivery: string;
    }
  >();

  constructor(config: TurnCutConfig | undefined) {
    this.policy = resolveCutPolicy(config);
  }

  /** Why `error` cuts the turn rather than failing it, or undefined when it does not. */
  reasonOf(error: unknown): TurnCutReason | undefined {
    return cutReasonOf(error);
  }

  /** The turn's mark: the stored one or this harness's, whichever counts more cuts. */
  markOf(threadId: string, turn: CutTurn): CutMark | undefined {
    const kept = this.marks.get(threadId);
    const mine = kept?.delivery === deliveryOf(turn) ? kept : undefined;
    if (!mine) {
      return turn.cut;
    }
    if (!turn.cut || turn.cut.count < mine.count) {
      return mine;
    }
    return turn.cut;
  }

  /**
   * The mark for one more cut of the turn, kept here; undefined when the turn has
   * been cut as often as the policy allows, and fails instead.
   */
  cut(threadId: string, turn: CutTurn, reason: TurnCutReason, at: number): CutMark | undefined {
    const count = (this.markOf(threadId, turn)?.count ?? 0) + 1;
    if (count > this.policy.attempts) {
      this.marks.delete(threadId);
      return undefined;
    }
    const mark = {
      reason,
      count,
      at,
    };
    this.marks.set(threadId, {
      ...mark,
      delivery: deliveryOf(turn),
    });
    return mark;
  }

  /** When a turn with `mark` is due again. */
  dueAt(mark: CutMark): number {
    const delay = this.policy.delayMs * 2 ** Math.max(0, mark.count - 1);
    return mark.at + Math.min(this.policy.maxDelayMs, delay);
  }

  /** The thread's turn ended, parked or was dropped: its cuts no longer count. */
  forget(threadId: string): void {
    this.marks.delete(threadId);
  }
}

//#endregion
