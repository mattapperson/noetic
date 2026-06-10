import { describe, expect, test } from 'bun:test';
import { resolveOpenChatTransition } from '../src/tui/app-parts/helpers.js';

const FOUND = {
  socketPath: '/tmp/runner.sock',
  roleLabel: 'planner',
};

describe('resolveOpenChatTransition', () => {
  test('fast path (no wait): found target opens the chat', () => {
    expect(
      resolveOpenChatTransition({
        current: {
          kind: 'taskBoard',
        },
        taskId: 'T-1',
        waited: false,
        found: FOUND,
      }),
    ).toEqual({
      kind: 'taskChat',
      socketPath: FOUND.socketPath,
      taskId: 'T-1',
      roleLabel: FOUND.roleLabel,
    });
  });

  test('fast path (no wait): no target falls back to the task board', () => {
    expect(
      resolveOpenChatTransition({
        current: {
          kind: 'taskBoard',
        },
        taskId: 'T-1',
        waited: false,
        found: null,
      }),
    ).toEqual({
      kind: 'taskBoard',
    });
  });

  test('waited + still on our own spawning view: opens the chat', () => {
    expect(
      resolveOpenChatTransition({
        current: {
          kind: 'taskChatSpawning',
          taskId: 'T-1',
        },
        taskId: 'T-1',
        waited: true,
        found: FOUND,
      }),
    ).toEqual({
      kind: 'taskChat',
      socketPath: FOUND.socketPath,
      taskId: 'T-1',
      roleLabel: FOUND.roleLabel,
    });
  });

  test('waited + user escaped to chat: keeps the current view (F6 repro)', () => {
    expect(
      resolveOpenChatTransition({
        current: {
          kind: 'chat',
        },
        taskId: 'T-1',
        waited: true,
        found: FOUND,
      }),
    ).toEqual({
      kind: 'chat',
    });
  });

  test("waited + a different task's spawning view: keeps the current view", () => {
    expect(
      resolveOpenChatTransition({
        current: {
          kind: 'taskChatSpawning',
          taskId: 'T-2',
        },
        taskId: 'T-1',
        waited: true,
        found: FOUND,
      }),
    ).toEqual({
      kind: 'taskChatSpawning',
      taskId: 'T-2',
    });
  });

  test('waited + own spawning view + no target: falls back to the task board', () => {
    expect(
      resolveOpenChatTransition({
        current: {
          kind: 'taskChatSpawning',
          taskId: 'T-1',
        },
        taskId: 'T-1',
        waited: true,
        found: null,
      }),
    ).toEqual({
      kind: 'taskBoard',
    });
  });
});
