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
 * cut off by a crash, a cancel, a steer, or a dropped connection. Until settled it is
 * held at `ceiling`.
 *
 * A record that no longer reads is listed too, with `unreadable: true`, so its bill is
 * never lost. Only `id`, `executionId`, and `threadId` are real on such a record; the
 * other required fields hold placeholders (`kind: 'model'`, `model: 'unknown'`,
 * `requestHash: ''`, `inputTokens: 0`, `sentAt` the Unix epoch), and it has no
 * `ceiling` or `generationId`. Check `unreadable` before trusting them.
 */
export interface PendingSpend {
  readonly id: string;
  /**
   * The stored record no longer reads — torn by a crash mid-write, or corrupted. Its
   * call was paid for, but its model and size are unknown, so it has no ceiling and is
   * never priced: it adds nothing to `heldCost`, and `spend_pending` flags it
   * `unreadable` and `unbounded`. It stays pending until `harness.writeOffSpend()`.
   */
  readonly unreadable?: true;
  readonly kind: SpendKind;
  readonly model: string;
  /** Hash of the request body sent. */
  readonly requestHash: string;
  /**
   * The most prompt tokens the call can cost: the request body's UTF-8 bytes, plus
   * allowances for the provider's framing and each media part.
   */
  readonly inputTokens: number;
  /** The request's output cap, when it set one. */
  readonly maxOutputTokens?: number;
  /**
   * Id of the root context the call ran under. An unreadable record that no longer
   * names one is listed with every execution, since it may belong to any of them.
   */
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
   * `inputTokens` and the output cap. Absent when the model publishes no price, no
   * output cap is known, or the record is unreadable.
   */
  readonly ceiling?: number;
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
