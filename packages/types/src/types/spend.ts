/**
 * Paid provider calls that have no settled bill yet — see spec 23 § Paid dispatches.
 */

/** @public What kind of provider call a dispatch was. */
export const SpendKind = {
  Model: 'model',
  Decide: 'decide',
} as const;

/** @public */
export type SpendKind = (typeof SpendKind)[keyof typeof SpendKind];

/**
 * @public
 * A paid provider call recorded before it was sent that has no settled bill: it was
 * cut off by a crash, a cancel, a steer, or a dropped connection. A record that no
 * longer reads is listed too, as an `UnreadableDispatch`, so its bill is never lost.
 */
export type PendingSpend = PendingDispatch | UnreadableDispatch;

/**
 * @public
 * A pending paid call whose record reads. Until settled it is held at `ceiling`.
 */
export interface PendingDispatch {
  readonly id: string;
  /** Never set: narrows `PendingSpend` against `UnreadableDispatch`. */
  readonly unreadable?: never;
  readonly kind: SpendKind;
  readonly model: string;
  /** Hash of the request body sent. */
  readonly requestHash: string;
  /** Estimate of the prompt's tokens. */
  readonly inputTokens: number;
  /** The request's output cap, when it set one. */
  readonly maxOutputTokens?: number;
  /** Id of the root context the call ran under. */
  readonly executionId?: string;
  readonly threadId?: string;
  /** Ledger key of the round or step that made the call. */
  readonly path?: string;
  /** The provider's id for the call, saved as soon as its response headers arrived. */
  readonly generationId?: string;
  /** ISO-8601. */
  readonly sentAt: string;
  /**
   * USD the call can have cost at most: the model's published prices applied to
   * `inputTokens` and the output cap. Absent when the model publishes no price, or
   * no output cap is known.
   */
  readonly ceiling?: number;
}

/**
 * @public
 * A dispatch record that no longer reads — torn by a crash mid-write, or corrupted. A
 * paid call was sent, but neither its model nor its size is known, so it has no
 * ceiling and is never priced: like a dispatch with no ceiling, it adds nothing to
 * `heldCost`, and `spend_pending` flags it `unreadable` and `unbounded`. It stays
 * pending until written off with `harness.writeOffSpend()`.
 */
export interface UnreadableDispatch {
  readonly id: string;
  readonly unreadable: true;
  /**
   * The execution the record still names. Absent when unreadable too, in which case
   * the dispatch is listed with every execution, since it may belong to any of them.
   */
  readonly executionId?: string;
  /** The thread the record still names. */
  readonly threadId?: string;
}

/** @public A pending dispatch whose bill is now known, or was written off. */
export interface SpendSettlement {
  readonly id: string;
  readonly executionId?: string;
  readonly threadId?: string;
  /** USD the provider billed, or the amount written off. */
  readonly cost: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly writtenOff?: true;
}

/** @public Options for `harness.reconcileSpend()`. */
export interface ReconcileSpendOptions {
  /** Only this execution's dispatches. Default: every pending dispatch. */
  executionId?: string;
  /** How long to keep asking the provider for a call it has not priced yet, in ms. Default 60 000. */
  patienceMs?: number;
}

/** @public Options for `harness.writeOffSpend()`. */
export interface WriteOffSpendOptions {
  /** USD to settle the dispatch at. */
  assumedCost: number;
}
