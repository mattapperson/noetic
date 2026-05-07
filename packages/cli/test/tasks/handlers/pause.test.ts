import { describe, expect, it } from 'bun:test';

import type { ControlSignal, Signaller } from '../../../src/tasks/runtime/agent-ci-control.js';
import { createTaskHandler } from '../../../src/tasks/runtime/handlers/lifecycle.js';
import { pauseTaskHandler } from '../../../src/tasks/runtime/handlers/state.js';
import { saveRunner } from '../../../src/tasks/runtime/runner-state.js';
import { makeStoreContext } from '../_helpers.js';

interface RecordedSignal {
  readonly target: number;
  readonly signal: ControlSignal;
}

function makeSignaller(opts: { alive: boolean; startTime: string }): {
  signaller: Signaller;
  signals: RecordedSignal[];
} {
  const signals: RecordedSignal[] = [];
  return {
    signaller: {
      kill(target, signal) {
        signals.push({
          target,
          signal,
        });
      },
      isAlive() {
        return opts.alive;
      },
      startTime() {
        return opts.startTime;
      },
    },
    signals,
  };
}

describe('pauseTaskHandler', () => {
  it('SIGSTOPs the runner group when active', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Pause target',
    });
    await saveRunner(ctx, {
      taskId: created.task.id,
      sessionId: 'sess-1',
      pid: 4242,
      pidStarttime: 'Fri Apr 25 10:00:00 2026',
      workflow: '.github/workflows/review.yml',
      startedAt: '2026-04-30T00:00:00.000Z',
      pausedAt: null,
    });
    const { signaller, signals } = makeSignaller({
      alive: true,
      startTime: 'Fri Apr 25 10:00:00 2026',
    });
    const result = await pauseTaskHandler(ctx, {
      taskId: created.task.id,
      signaller,
    });
    expect(result.outcome.kind).toBe('paused');
    expect(signals[0]?.signal).toBe('SIGSTOP');
    expect(signals[0]?.target).toBe(-4242);
  });

  it('returns no_active_run when no runner is recorded', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'No runner',
    });
    const { signaller } = makeSignaller({
      alive: false,
      startTime: '',
    });
    const result = await pauseTaskHandler(ctx, {
      taskId: created.task.id,
      signaller,
    });
    expect(result.outcome.kind).toBe('no_active_run');
  });

  it('throws on missing task', async () => {
    const ctx = makeStoreContext();
    await expect(
      pauseTaskHandler(ctx, {
        taskId: 'T-zzzzzzzzzz',
      }),
    ).rejects.toThrow();
  });
});
