/**
 * Tests for the IPC-backed `AskUserService`. The service implements the
 * same contract as the in-memory TUI service but routes broadcasts
 * through callbacks so the IPC server can fan them out to clients.
 */

import { describe, expect, it } from 'bun:test';

import { isNoeticError } from '@noetic/core';
import type { AskUserBroadcaster } from '../../src/commands/builtins/tasks/ipc-ask-user-service.js';
import { createIpcAskUserService } from '../../src/commands/builtins/tasks/ipc-ask-user-service.js';
import type { PendingAskUserRequest } from '../../src/tui/services/ask-user-service.js';

interface BroadcastLog {
  readonly broadcaster: AskUserBroadcaster;
  readonly requests: ReadonlyArray<PendingAskUserRequest>;
  readonly cleared: ReadonlyArray<string>;
}

function makeBroadcastLog(): BroadcastLog {
  const requests: PendingAskUserRequest[] = [];
  const cleared: string[] = [];
  return {
    broadcaster: {
      broadcastRequest(req) {
        requests.push(req);
      },
      broadcastCleared(id) {
        cleared.push(id);
      },
    },
    requests,
    cleared,
  };
}

const SAMPLE_INPUT = {
  questions: [
    {
      question: 'Pick a color?',
      header: 'color',
      multiSelect: false,
      options: [
        {
          label: 'Red',
          description: 'A warm color',
        },
        {
          label: 'Blue',
          description: 'A cool color',
        },
      ],
    },
  ],
};

describe('createIpcAskUserService', () => {
  it('broadcasts a pending request and resolves it via handleResolve', async () => {
    const log = makeBroadcastLog();
    const service = createIpcAskUserService(log.broadcaster);

    const promise = service.request(SAMPLE_INPUT);
    expect(log.requests.length).toBe(1);
    const request = log.requests[0];
    if (request === undefined) {
      throw new Error('expected one broadcast request');
    }
    expect(request.input).toEqual(SAMPLE_INPUT);
    expect(service.peek()?.id).toBe(request.id);

    service.handleResolve(request.id, {
      answers: {
        'Pick a color?': 'Red',
      },
    });
    const output = await promise;
    expect(output.answers['Pick a color?']).toBe('Red');
    expect(log.cleared).toEqual([
      request.id,
    ]);
    expect(service.peek()).toBeNull();
  });

  it('rejects pending request when handleCancel fires', async () => {
    const log = makeBroadcastLog();
    const service = createIpcAskUserService(log.broadcaster);

    const promise = service.request(SAMPLE_INPUT);
    const id = log.requests[0]?.id;
    if (id === undefined) {
      throw new Error('expected one broadcast request');
    }

    service.handleCancel(id, 'user dismissed');
    let caught: unknown = null;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(isNoeticError(caught)).toBe(true);
    if (isNoeticError(caught)) {
      expect(caught.noeticError.kind).toBe('cancelled');
    }
    expect(log.cleared).toEqual([
      id,
    ]);
    expect(service.peek()).toBeNull();
  });

  it('rejects a second concurrent request with AskUserBusyError', async () => {
    const log = makeBroadcastLog();
    const service = createIpcAskUserService(log.broadcaster);

    const first = service.request(SAMPLE_INPUT);
    let busyError: unknown = null;
    try {
      await service.request(SAMPLE_INPUT);
    } catch (err) {
      busyError = err;
    }
    expect(busyError).toBeInstanceOf(Error);
    if (!(busyError instanceof Error)) {
      throw new Error('expected busyError to be an Error');
    }
    expect(busyError.message).toMatch(/already pending/i);

    // Clean up the first deferred so the test doesn't dangle.
    const id = log.requests[0]?.id;
    if (id === undefined) {
      throw new Error('expected one broadcast request');
    }
    service.cancel(id, 'cleanup');
    await first.catch(() => {
      /* expected cancellation */
    });
  });

  it('cancelAll clears any pending request without needing the id', async () => {
    const log = makeBroadcastLog();
    const service = createIpcAskUserService(log.broadcaster);

    const promise = service.request(SAMPLE_INPUT);
    expect(service.peek()).not.toBeNull();
    service.cancelAll('shutdown');
    let caught: unknown = null;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(isNoeticError(caught)).toBe(true);
    expect(service.peek()).toBeNull();
    expect(log.cleared.length).toBe(1);
  });

  it('handleResolve is a no-op when id does not match', async () => {
    const log = makeBroadcastLog();
    const service = createIpcAskUserService(log.broadcaster);

    const promise = service.request(SAMPLE_INPUT);
    service.handleResolve('not-the-real-id', {
      answers: {
        'Pick a color?': 'Red',
      },
    });
    expect(service.peek()).not.toBeNull();
    expect(log.cleared.length).toBe(0);

    // Resolve properly so the test cleans up.
    const realId = log.requests[0]?.id;
    if (realId === undefined) {
      throw new Error('expected request id');
    }
    service.handleResolve(realId, {
      answers: {
        'Pick a color?': 'Blue',
      },
    });
    const output = await promise;
    expect(output.answers['Pick a color?']).toBe('Blue');
  });

  it('subscribe fires immediately with current state and notifies on changes', async () => {
    const log = makeBroadcastLog();
    const service = createIpcAskUserService(log.broadcaster);

    const seen: Array<PendingAskUserRequest | null> = [];
    const unsubscribe = service.subscribe((p) => {
      seen.push(p);
    });
    expect(seen).toEqual([
      null,
    ]);

    const promise = service.request(SAMPLE_INPUT);
    expect(seen.length).toBe(2);
    expect(seen[1]).not.toBeNull();

    const id = log.requests[0]?.id;
    if (id === undefined) {
      throw new Error('expected request id');
    }
    service.handleResolve(id, {
      answers: {
        'Pick a color?': 'Red',
      },
    });
    await promise;
    expect(seen[seen.length - 1]).toBeNull();

    unsubscribe();
  });
});
