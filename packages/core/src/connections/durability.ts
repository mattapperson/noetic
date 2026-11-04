/**
 * Durability (spec 35 § Durability): idempotency keys, the pending ledger
 * entry a `call` or `wait` writes before it reaches a server, and what a
 * resumed run does with a connection that was replaced.
 *
 * If a connection's identity instance changed, results recorded against it
 * describe a world that is gone. Its determinism decides, following OVP's
 * resume strategy:
 *
 * | `replayPrefix` | Resume |
 * |---|---|
 * | `'free'` | Discard the ledger from the first step that used it; run live. |
 * | `'costly'`, with `reset` | Reset the connection, then the same. |
 * | `'unsafe'` | Refuse until `harness.restore(id, { rerun: [name] })`. |
 *
 * An epoch change alone (a hot reload) keeps refs and results. A connection
 * that declares no determinism is treated as `'unsafe'`.
 */

import type {
  ConnectionIdentity,
  ConnectionLease,
  Context,
  Determinism,
} from '@noetic-tools/types';
import { ContextImpl } from '../runtime/context-impl';

//#region Types

/**
 * What a `call` or `wait` records before it reaches a server, so a resumed
 * step against the same identity picks up where it was.
 */
export interface PendingConnectionEntry {
  /** The call's idempotency key. */
  readonly key: string;
  readonly connection: string;
  readonly identity: ConnectionIdentity;
  /** The long operation, once the server returned one. */
  readonly taskId?: string;
  readonly lease?: ConnectionLease;
  /** For waits: the cursor listening started from. */
  readonly cursor?: string | null;
  /** For waits: epoch ms the wait gives up. */
  readonly deadline?: number;
}

/** What a resumed run does about one connection. */
export type ResumeDecision =
  /** Same instance: replay recorded results. */
  | 'keep'
  /** Replaced: discard the ledger from the first step that used it and run live. */
  | 'discard'
  /** Replaced: reset the connection, then discard. */
  | 'reset'
  /** Replaced and unsafe to drive again: stop with `connection_resume_refused`. */
  | 'refuse';

//#endregion

//#region Helpers

/** Calls each owner gave an id, by step. */
const CALL_COUNTS = new WeakMap<object, Map<string, number>>();

/** FNV-1a over `text`, as 8 hex digits: a short, stable digest. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

//#endregion

//#region Public API

/** The ledger path of the step running on `ctx`, when it runs on a lane. */
export function stepPathOf(ctx: Context): string | undefined {
  const path = ctx instanceof ContextImpl ? ctx.currentPath() : '';
  return path.length > 0 ? path : undefined;
}

/**
 * An id for a tool call that brings none — a step running a tool directly, or
 * an agent call with no id: the step's place in the run and the call's place
 * among the calls `owner` gave ids in that step. A resumed step makes its
 * calls in the same order, so it gets the same ids, and two equal calls get
 * two ids.
 */
export function orderedCallId(owner: object, ctx: Context, stepId?: string): string {
  const step = stepPathOf(ctx) ?? stepId ?? ctx.id;
  const counts = CALL_COUNTS.get(owner) ?? new Map<string, number>();
  CALL_COUNTS.set(owner, counts);
  const order = counts.get(step) ?? 0;
  counts.set(step, order + 1);
  return `derived-${digest(`${step}\u0000${order}`)}`;
}

/** The idempotency key of a step's call: the run and the step's ledger key. */
export function stepIdempotencyKey(executionId: string, ledgerKey: string): string {
  return `${executionId}:${ledgerKey}`;
}

/** The idempotency key of a model tool call: the turn's execution and the tool call id. */
export function toolIdempotencyKey(executionId: string, toolCallId: string): string {
  return `${executionId}:tool:${toolCallId}`;
}

/** Whether `current` is the same thing `recorded` described (an epoch change alone keeps it). */
export function sameInstance(recorded: ConnectionIdentity, current: ConnectionIdentity): boolean {
  return recorded.surface === current.surface && recorded.instance === current.instance;
}

/**
 * Decides what a resumed run does about a connection whose results were
 * recorded against `recorded`.
 */
export function resumeDecision(params: {
  readonly recorded: ConnectionIdentity;
  readonly current: ConnectionIdentity;
  readonly determinism: Determinism | undefined;
  /** `harness.restore(id, { rerun })` named this connection. */
  readonly rerunAllowed: boolean;
  /** The connection can be reset. */
  readonly canReset: boolean;
}): ResumeDecision {
  if (sameInstance(params.recorded, params.current)) {
    return 'keep';
  }
  if (params.rerunAllowed) {
    return 'discard';
  }
  const replay = params.determinism?.replayPrefix ?? 'unsafe';
  if (replay === 'free') {
    return 'discard';
  }
  const resettable = params.canReset && (params.determinism?.reset ?? 'none') !== 'none';
  if (replay === 'costly' && resettable) {
    return 'reset';
  }
  return 'refuse';
}

//#endregion
