/**
 * Ask-user service — in-memory pending-request store.
 *
 * Tool code calls `request(input)` and awaits a Promise. Hosts subscribe
 * via `subscribe()`, render a modal (or forward over IPC) when a
 * request lands, and resolve via `resolve(output)` or `cancel(reason)`
 * when the user submits/dismisses.
 *
 * Only one concurrent request is permitted per service — a second
 * `request()` while one is pending throws `AskUserBusyError`.
 * Cancellation is reported as a `NoeticErrorImpl({ kind: 'cancelled' })`
 * so the harness's error pipeline maps it to the canonical `cancelled`
 * runtime error.
 */

import { NoeticErrorImpl } from '@noetic/core';

import type { AskUserInput, AskUserOutput } from './tools/ask-user-types.js';

//#region Types

export interface PendingAskUserRequest {
  readonly id: string;
  readonly input: AskUserInput;
  readonly createdAt: number;
}

export type AskUserListener = (pending: PendingAskUserRequest | null) => void;

export interface AskUserService {
  /** Enqueue a request; resolves when the host calls `resolve()`, rejects on `cancel()`/`cancelAll()`. */
  request(input: AskUserInput): Promise<AskUserOutput>;
  /** Subscribe to pending-request changes. Returns an unsubscribe fn. Fires immediately with current state. */
  subscribe(listener: AskUserListener): () => void;
  /** Current pending request, or null. */
  peek(): PendingAskUserRequest | null;
  /** Resolve the currently-pending request with an output. No-op if none pending or id mismatches. */
  resolve(id: string, output: AskUserOutput): void;
  /** Cancel the currently-pending request with a reason. No-op if none pending or id mismatches. */
  cancel(id: string, reason: string): void;
  /**
   * Cancel any currently-pending request without needing the id. Used by
   * hosts on harness swaps, user-stop, and session reset so a ghost
   * dialog can't outlive the harness that produced it.
   */
  cancelAll(reason: string): void;
}

/**
 * Internal contract violation: a second `request()` arrived while one was
 * still pending. The host should never expose this to the model — it
 * indicates a bug in the bridge wiring rather than a runtime error worth
 * mapping into the framework error model.
 */
export class AskUserBusyError extends Error {
  readonly kind = 'ask-user-busy' as const;
  constructor() {
    super('Another ask-user request is already pending');
    this.name = 'AskUserBusyError';
  }
}

/**
 * Build the canonical cancellation rejection. Uses the existing
 * `NoeticError` `cancelled` kind so callers can match via
 * `isNoeticError(e) && e.noeticError.kind === 'cancelled'`.
 */
export function createAskUserCancelledError(reason: string): NoeticErrorImpl {
  return new NoeticErrorImpl({
    kind: 'cancelled',
    reason: `ask-user dialog cancelled: ${reason}`,
  });
}

//#endregion

//#region Factory

interface PendingInternal {
  readonly request: PendingAskUserRequest;
  readonly resolve: (out: AskUserOutput) => void;
  readonly reject: (err: Error) => void;
}

export function createAskUserService(): AskUserService {
  let pending: PendingInternal | null = null;
  const listeners = new Set<AskUserListener>();

  const notify = (): void => {
    const snapshot = pending?.request ?? null;
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A broken subscriber shouldn't tank the service.
      }
    }
  };

  const settleRejection = (reason: string): void => {
    if (pending === null) {
      return;
    }
    const settled = pending;
    pending = null;
    settled.reject(createAskUserCancelledError(reason));
    notify();
  };

  const service: AskUserService = {
    async request(input) {
      if (pending !== null) {
        throw new AskUserBusyError();
      }
      const id = crypto.randomUUID();
      return new Promise<AskUserOutput>((resolve, reject) => {
        pending = {
          request: {
            id,
            input,
            createdAt: Date.now(),
          },
          resolve,
          reject,
        };
        notify();
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      try {
        listener(pending?.request ?? null);
      } catch {
        // ignore
      }
      return () => {
        listeners.delete(listener);
      };
    },

    peek() {
      return pending?.request ?? null;
    },

    resolve(id, output) {
      if (pending === null || pending.request.id !== id) {
        return;
      }
      const settled = pending;
      pending = null;
      settled.resolve(output);
      notify();
    },

    cancel(id, reason) {
      if (pending === null || pending.request.id !== id) {
        return;
      }
      settleRejection(reason);
    },

    cancelAll(reason) {
      settleRejection(reason);
    },
  };

  return service;
}

//#endregion
