import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExecuteInput, ExecuteOptions, InputMessageItem, Item } from '@noetic/core';
import { createLocalFsAdapter } from '@noetic/core';

import { loadTask, saveTask } from '../../src/commands/builtins/tasks/fs-store.js';
import { createIpcAskUserService } from '../../src/commands/builtins/tasks/ipc-ask-user-service.js';
import {
  createRunnerSignal,
  escalateStalledRunner,
  runRunnerLoop,
} from '../../src/commands/builtins/tasks/runner-harness.js';
import type { Task } from '../../src/commands/builtins/tasks/schemas.js';
import {
  AutopilotState,
  TaskLifecycleStatus,
  TaskPauseReason,
  TaskReviewStatus,
  TaskSource,
} from '../../src/commands/builtins/tasks/schemas.js';

const NOW = '2026-05-02T00:00:00.000Z';

interface TestContext {
  readonly projectRoot: string;
  readonly taskId: string;
  readonly storeCtx: {
    readonly fs: ReturnType<typeof createLocalFsAdapter>;
    readonly projectRoot: string;
  };
}

interface StubHarness {
  readonly executeCalls: ExecuteInput[];
  execute(input: ExecuteInput, options?: ExecuteOptions): Promise<void>;
  seedSessionHistory(threadId: string, history: ReadonlyArray<Item>): void;
}

async function createTaskFixture(): Promise<TestContext> {
  const projectRoot = await mkdtemp(join('/tmp', 'n-runner-'));
  const fs = createLocalFsAdapter();
  const taskId = 'T-stall00001';
  const storeCtx = {
    fs,
    projectRoot,
  };
  const task: Task = {
    id: taskId,
    source: TaskSource.Manual,
    title: 'stalled-test-task',
    projectRoot,
    worktreePath: null,
    branch: null,
    headSha: null,
    reviewStatus: TaskReviewStatus.NotStarted,
    lifecycleStatus: TaskLifecycleStatus.Active,
    paused: false,
    pauseReason: null,
    archivedAt: null,
    hierarchyStatus: null,
    autopilotEnabled: false,
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
  };
  await fs.mkdir(`${projectRoot}/.noetic`);
  await fs.mkdir(`${projectRoot}/.noetic/tasks`);
  await fs.mkdir(`${projectRoot}/.noetic/tasks/${taskId}`);
  await saveTask(storeCtx, task);
  return {
    projectRoot,
    taskId,
    storeCtx,
  };
}

async function tearDown(ctx: TestContext): Promise<void> {
  await rm(ctx.projectRoot, {
    recursive: true,
    force: true,
  });
}

function isInputMessageItem(value: unknown): value is InputMessageItem {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('type' in value) || value.type !== 'message') {
    return false;
  }
  if (!('role' in value) || value.role !== 'developer') {
    return false;
  }
  return true;
}

const INITIAL_MESSAGE: InputMessageItem = {
  id: 'runner-init-test',
  type: 'message',
  role: 'developer',
  status: 'completed',
  content: [
    {
      type: 'input_text',
      text: 'kick off',
    },
  ],
};

describe('runner-harness', () => {
  describe('createRunnerSignal', () => {
    it('resolves with the value passed to resolve()', async () => {
      const signal = createRunnerSignal<{
        readonly status: 'completed';
      }>();
      signal.resolve({
        status: 'completed',
      });
      const outcome = await signal.done;
      expect(outcome).toEqual({
        status: 'completed',
      });
    });

    it('rejects with the value passed to reject()', async () => {
      const signal = createRunnerSignal<unknown>();
      const err = new Error('boom');
      signal.reject(err);
      await expect(signal.done).rejects.toBe(err);
    });

    it('is single-shot — second resolve after first is ignored', async () => {
      const signal = createRunnerSignal<number>();
      signal.resolve(1);
      signal.resolve(2);
      const v = await signal.done;
      expect(v).toBe(1);
    });

    it('is single-shot — reject after resolve is ignored', async () => {
      const signal = createRunnerSignal<number>();
      signal.resolve(7);
      signal.reject(new Error('late reject'));
      const v = await signal.done;
      expect(v).toBe(7);
    });

    it('is single-shot — resolve after reject is ignored', async () => {
      const signal = createRunnerSignal<number>();
      const err = new Error('first');
      signal.reject(err);
      signal.resolve(99);
      await expect(signal.done).rejects.toBe(err);
    });
  });

  describe('escalateStalledRunner', () => {
    it('marks the task paused with pauseReason=agent_stalled and emits an event', async () => {
      const ctx = await createTaskFixture();
      try {
        await escalateStalledRunner({
          storeCtx: ctx.storeCtx,
          taskId: ctx.taskId,
          role: 'planner',
        });
        const reloaded = await loadTask(ctx.storeCtx, ctx.taskId);
        expect(reloaded.paused).toBe(true);
        expect(reloaded.pauseReason).toBe(TaskPauseReason.AgentStalled);
        const eventsRaw = await ctx.storeCtx.fs.readFileText(
          `${ctx.projectRoot}/.noetic/tasks/_events.jsonl`,
        );
        const lines = eventsRaw.split('\n').filter((l) => l.length > 0);
        const events = lines.map((l) => JSON.parse(l));
        const stalled = events.find(
          (e: {
            taskId: string | null;
            payload?: {
              phase?: string;
            };
          }) => e.taskId === ctx.taskId && e.payload?.phase === 'agent_stalled',
        );
        expect(stalled).not.toBeUndefined();
        expect(stalled?.payload?.role).toBe('planner');
      } finally {
        await tearDown(ctx);
      }
    });
  });

  describe('runRunnerLoop nudge behaviour', () => {
    it('does not nudge when the agent calls a terminal tool on the first turn', async () => {
      const ctx = await createTaskFixture();
      try {
        const askUserService = createIpcAskUserService({
          broadcastRequest: () => {},
          broadcastCleared: () => {},
        });
        const signal = createRunnerSignal<{
          readonly status: 'completed';
        }>();
        const harness: StubHarness = {
          executeCalls: [],
          async execute(input) {
            harness.executeCalls.push(input);
            // Simulate agent calling a terminal tool inline.
            signal.resolve({
              status: 'completed',
            });
          },
          seedSessionHistory() {},
        };

        const outcome = await runRunnerLoop({
          harness,
          threadId: 'thread-1',
          initialMessage: INITIAL_MESSAGE,
          signal,
          storeCtx: ctx.storeCtx,
          taskId: ctx.taskId,
          nudge: {
            role: 'planner',
            askUserService,
            buildStalledOutcome: () => ({
              status: 'completed',
            }),
          },
        });

        expect(outcome.status).toBe('completed');
        expect(harness.executeCalls.length).toBe(1);
        const reloaded = await loadTask(ctx.storeCtx, ctx.taskId);
        expect(reloaded.paused).toBe(false);
      } finally {
        await tearDown(ctx);
      }
    });

    it('sends one nudge then escalates when the agent stalls twice', async () => {
      const ctx = await createTaskFixture();
      try {
        const askUserService = createIpcAskUserService({
          broadcastRequest: () => {},
          broadcastCleared: () => {},
        });
        const signal = createRunnerSignal<{
          readonly status: 'completed' | 'stalled';
        }>();
        const harness: StubHarness = {
          executeCalls: [],
          async execute(input) {
            harness.executeCalls.push(input);
            // Never resolve the signal — both turns end without progress.
          },
          seedSessionHistory() {},
        };

        const outcome = await runRunnerLoop({
          harness,
          threadId: 'thread-1',
          initialMessage: INITIAL_MESSAGE,
          signal,
          storeCtx: ctx.storeCtx,
          taskId: ctx.taskId,
          nudge: {
            role: 'planner',
            askUserService,
            buildStalledOutcome: () => ({
              status: 'stalled',
            }),
          },
        });

        expect(outcome.status).toBe('stalled');
        expect(harness.executeCalls.length).toBe(2);
        const second = harness.executeCalls[1];
        expect(isInputMessageItem(second)).toBe(true);
        if (isInputMessageItem(second)) {
          const first = second.content[0];
          if (first?.type !== 'input_text') {
            throw new Error('expected nudge to be input_text content');
          }
          expect(first.text).toMatch(/AskUserQuestion/);
        }
        const reloaded = await loadTask(ctx.storeCtx, ctx.taskId);
        expect(reloaded.paused).toBe(true);
        expect(reloaded.pauseReason).toBe(TaskPauseReason.AgentStalled);
      } finally {
        await tearDown(ctx);
      }
    });

    it('skips the nudge when the agent has an outstanding ask-user request', async () => {
      const ctx = await createTaskFixture();
      try {
        const askUserService = createIpcAskUserService({
          broadcastRequest: () => {},
          broadcastCleared: () => {},
        });
        const signal = createRunnerSignal<{
          readonly status: 'completed' | 'stalled';
        }>();
        let askedReadyResolve: () => void = () => {};
        const askedReady = new Promise<void>((res) => {
          askedReadyResolve = res;
        });
        const harness: StubHarness = {
          executeCalls: [],
          async execute(input) {
            harness.executeCalls.push(input);
            // Simulate the agent calling AskUserQuestion mid-turn:
            // start the request and let the test resolve/cancel it.
            const ask = askUserService.request({
              questions: [
                {
                  question: 'continue?',
                  header: 'go',
                  multiSelect: false,
                  options: [
                    {
                      label: 'Yes',
                      description: 'go',
                    },
                    {
                      label: 'No',
                      description: 'stop',
                    },
                  ],
                },
              ],
            });
            askedReadyResolve();
            try {
              await ask;
            } catch {
              // Cancellation expected during teardown.
            }
          },
          seedSessionHistory() {},
        };

        const loopPromise = runRunnerLoop({
          harness,
          threadId: 'thread-1',
          initialMessage: INITIAL_MESSAGE,
          signal,
          storeCtx: ctx.storeCtx,
          taskId: ctx.taskId,
          nudge: {
            role: 'planner',
            askUserService,
            buildStalledOutcome: () => ({
              status: 'stalled',
            }),
          },
        });

        // Wait until the agent has issued its ask-user request, then
        // confirm only one execute call has happened (no nudge yet).
        await askedReady;
        expect(harness.executeCalls.length).toBe(1);

        // Cancel the pending request and complete the run via the
        // signal. The loop should not have sent a nudge because the
        // ask-user was outstanding when execute() returned.
        const pending = askUserService.peek();
        if (pending !== null) {
          askUserService.handleCancel(pending.id, 'test cleanup');
        }
        signal.resolve({
          status: 'completed',
        });
        const outcome = await loopPromise;
        expect(outcome.status).toBe('completed');
        expect(harness.executeCalls.length).toBe(1);
        const reloaded = await loadTask(ctx.storeCtx, ctx.taskId);
        expect(reloaded.paused).toBe(false);
      } finally {
        await tearDown(ctx);
      }
    });
  });
});
