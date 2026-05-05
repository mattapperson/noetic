/**
 * Unit tests for AskUserService — the in-memory pending-request store that
 * bridges the async ask-user tool and the Ink modal.
 */

import { describe, expect, test } from 'bun:test';
import { AskUserBusyError, createAskUserService } from '@noetic/code-agent/ask-user-service';
import type { AskUserInput, AskUserOutput } from '@noetic/core';
import { isNoeticError } from '@noetic/core';

function makeInput(): AskUserInput {
  return {
    questions: [
      {
        question: 'Which database?',
        header: 'Database',
        multiSelect: false,
        options: [
          {
            label: 'Postgres',
            description: 'Default.',
          },
          {
            label: 'SQLite',
            description: 'Embedded.',
          },
        ],
      },
    ],
  };
}

async function expectAskUserCancelled(p: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeDefined();
  expect(isNoeticError(caught)).toBe(true);
  if (isNoeticError(caught)) {
    expect(caught.noeticError.kind).toBe('cancelled');
  }
}

describe('AskUserService', () => {
  test('request resolves when the TUI calls resolve with the matching id', async () => {
    const service = createAskUserService();
    const pending = service.request(makeInput());
    const current = service.peek();
    expect(current).not.toBeNull();
    const output: AskUserOutput = {
      answers: {
        'Which database?': 'Postgres',
      },
    };
    service.resolve(current!.id, output);
    await expect(pending).resolves.toEqual(output);
    expect(service.peek()).toBeNull();
  });

  test('cancel rejects with NoeticErrorImpl whose noeticError.kind === "cancelled"', async () => {
    const service = createAskUserService();
    const pending = service.request(makeInput());
    const current = service.peek();
    expect(current).not.toBeNull();
    service.cancel(current!.id, 'user dismissed');
    await expectAskUserCancelled(pending);
  });

  test('concurrent request while one is pending rejects with AskUserBusyError', async () => {
    const service = createAskUserService();
    const first = service.request(makeInput());
    await expect(service.request(makeInput())).rejects.toBeInstanceOf(AskUserBusyError);
    const current = service.peek();
    service.cancel(current!.id, 'cleanup');
    await expectAskUserCancelled(first);
  });

  test('subscribe fires immediately with current state and on transitions', async () => {
    const service = createAskUserService();
    const events: Array<string | null> = [];
    const unsubscribe = service.subscribe((pending) => {
      events.push(pending?.id ?? null);
    });
    expect(events).toEqual([
      null,
    ]);

    const p = service.request(makeInput());
    const current = service.peek();
    expect(events).toHaveLength(2);
    expect(events[1]).toBe(current!.id);

    service.resolve(current!.id, {
      answers: {
        'Which database?': 'SQLite',
      },
    });
    await p;
    expect(events).toHaveLength(3);
    expect(events[2]).toBeNull();
    unsubscribe();
  });

  test('resolve/cancel with mismatched id is a no-op', async () => {
    const service = createAskUserService();
    const pending = service.request(makeInput());
    const current = service.peek();
    service.resolve('nope', {
      answers: {},
    });
    service.cancel('nope', 'nope');
    expect(service.peek()?.id).toBe(current!.id);
    service.resolve(current!.id, {
      answers: {
        'Which database?': 'Postgres',
      },
    });
    await expect(pending).resolves.toEqual({
      answers: {
        'Which database?': 'Postgres',
      },
    });
  });

  test('cancelAll rejects the pending request and notifies subscribers with null', async () => {
    const service = createAskUserService();
    const events: Array<string | null> = [];
    const unsubscribe = service.subscribe((p) => {
      events.push(p?.id ?? null);
    });
    const pending = service.request(makeInput());
    expect(service.peek()).not.toBeNull();
    service.cancelAll('harness swap');
    await expectAskUserCancelled(pending);
    expect(service.peek()).toBeNull();
    // initial null + pending id + cancelAll null
    expect(events).toEqual([
      null,
      events[1] ?? null,
      null,
    ]);
    unsubscribe();
  });

  test('cancelAll with no pending request is a safe no-op', () => {
    const service = createAskUserService();
    expect(() => service.cancelAll('nothing pending')).not.toThrow();
    expect(service.peek()).toBeNull();
  });
});
