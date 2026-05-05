/**
 * IPC-backed `AskUserService` for headless task runners.
 *
 * Headless task runners (planner / implementer / validator subprocesses)
 * have no in-process UI — their human counterpart is whatever client is
 * currently connected to the per-task IPC socket. This service implements
 * the same `AskUserService` contract by routing `request()` to a
 * `broadcast` callback (provided by the IPC server) and accepting
 * answers/cancellations through `handleResolve` / `handleCancel`
 * methods that the IPC server invokes when client frames arrive.
 *
 * Only one pending request at a time, mirroring the in-memory service.
 */

import type { AskUserInput, AskUserOutput } from '@noetic/core';

import type {
  AskUserListener,
  AskUserService,
  PendingAskUserRequest,
} from '../ask-user-service.js';
import { AskUserBusyError, createAskUserCancelledError } from '../ask-user-service.js';

//#region Types

/**
 * Side-channel the service uses to surface its state to connected IPC
 * clients. The factory consumer (the IPC server) owns the actual socket
 * fan-out; the service stays unaware of sockets.
 */
export interface AskUserBroadcaster {
  /** Notify subscribers that a new ask-user request is pending. */
  broadcastRequest(request: PendingAskUserRequest): void;
  /** Notify subscribers that the pending request has been resolved or cancelled. */
  broadcastCleared(id: string): void;
}

export interface IpcAskUserService extends AskUserService {
  /** Forward a client `askUserResolve` frame into the service. */
  handleResolve(id: string, output: AskUserOutput): void;
  /** Forward a client `askUserCancel` frame into the service. */
  handleCancel(id: string, reason: string): void;
}

interface PendingInternal {
  readonly request: PendingAskUserRequest;
  readonly resolve: (output: AskUserOutput) => void;
  readonly reject: (err: Error) => void;
}

//#endregion

//#region Factory

export function createIpcAskUserService(broadcaster: AskUserBroadcaster): IpcAskUserService {
  let pending: PendingInternal | null = null;
  const listeners = new Set<AskUserListener>();

  const notifyListeners = (): void => {
    const snapshot = pending?.request ?? null;
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A broken subscriber shouldn't tank the service.
      }
    }
  };

  const settleRejection = (id: string, reason: string): void => {
    if (pending === null) {
      return;
    }
    if (pending.request.id !== id) {
      return;
    }
    const settled = pending;
    pending = null;
    settled.reject(createAskUserCancelledError(reason));
    broadcaster.broadcastCleared(settled.request.id);
    notifyListeners();
  };

  const settleRejectionAny = (reason: string): void => {
    if (pending === null) {
      return;
    }
    const settled = pending;
    pending = null;
    settled.reject(createAskUserCancelledError(reason));
    broadcaster.broadcastCleared(settled.request.id);
    notifyListeners();
  };

  const enqueueRequest = (input: AskUserInput): Promise<AskUserOutput> => {
    if (pending !== null) {
      return Promise.reject(new AskUserBusyError());
    }
    const id = crypto.randomUUID();
    return new Promise<AskUserOutput>((resolve, reject) => {
      const request: PendingAskUserRequest = {
        id,
        input,
        createdAt: Date.now(),
      };
      pending = {
        request,
        resolve,
        reject,
      };
      broadcaster.broadcastRequest(request);
      notifyListeners();
    });
  };

  const fulfilRequest = (id: string, output: AskUserOutput): void => {
    if (pending === null) {
      return;
    }
    if (pending.request.id !== id) {
      return;
    }
    const settled = pending;
    pending = null;
    settled.resolve(output);
    broadcaster.broadcastCleared(settled.request.id);
    notifyListeners();
  };

  return {
    request: enqueueRequest,

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

    resolve: fulfilRequest,

    cancel: settleRejection,

    cancelAll(reason) {
      settleRejectionAny(reason);
    },

    handleResolve: fulfilRequest,

    handleCancel: settleRejection,
  };
}

//#endregion
