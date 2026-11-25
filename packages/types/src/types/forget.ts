/**
 * Forgetting a thread or an execution, and listing what is stored — see spec 23
 * § Forgetting.
 */

import type { SpendSettlement } from './spend';

/** @public Options for `harness.forget()`. */
export interface ForgetOptions {
  /** Keep the trail marks (spec 23 § The trail). Default false: nothing is kept. */
  keepTrail?: boolean;
  /** How long to wait for the provider to price a pending call, in ms. Default 60 000. */
  patienceMs?: number;
  /** How long to wait for another harness's lease on the thread to run out, in ms. Default 0. */
  waitMs?: number;
}

/** @public What `harness.forget()` did. */
export interface ForgetReport {
  /** The thread forgotten, for a thread's forget. */
  readonly threadId?: string;
  /** Every execution forgotten. */
  readonly executionIds: ReadonlyArray<string>;
  /** Every pending dispatch settled or written off before anything was deleted. */
  readonly spend: ReadonlyArray<SpendSettlement>;
}

/** @public A kind of record stored for an execution. */
export const ExecutionPart = {
  Snapshot: 'snapshot',
  Ledger: 'ledger',
  Trail: 'trail',
  Held: 'held',
  Intent: 'intent',
  Pending: 'pending',
  /** A link to an execution it spawned out of process. */
  Child: 'child',
  Other: 'other',
} as const;

/** @public */
export type ExecutionPart = (typeof ExecutionPart)[keyof typeof ExecutionPart];

/** @public An execution with something stored, as `harness.listStoredExecutions()` finds it. */
export interface StoredExecution {
  readonly executionId: string;
  /** The kinds of record stored for it. */
  readonly parts: ReadonlyArray<ExecutionPart>;
  /** A snapshot or ledger entries are stored, so `restore()` can rebuild it. A trail alone is not. */
  readonly resumable: boolean;
}

/** @public Options for `harness.listStoredThreads()` and `harness.listStoredExecutions()`. */
export interface ListStoredOptions {
  /** Only ids that start with this. */
  prefix?: string;
}
