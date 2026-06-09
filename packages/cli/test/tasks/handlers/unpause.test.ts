import { describe, expect, it } from 'bun:test';

import type { ControlSignal, Signaller } from '../../../src/tasks/runtime/agent-ci-control.js';
import { createTaskHandler } from '../../../src/tasks/runtime/handlers/lifecycle.js';
import { unpauseTaskHandler } from '../../../src/tasks/runtime/handlers/state.js';
import { saveRunner } from '../../../src/tasks/runtime/runner-state.js';
import { makeStoreContext } from '../_helpers.js';

interface RecordedSignal {
  readonly target: number;
  readonly signal: ControlSignal;
}

function makeSignaller(): {
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
        return true;
      },
      startTime() {
        return 'Fri Apr 25 10:00:00 2026';
      },
    },
    signals,
  };
}

describe('unpauseTaskHandler', () => {
  it('SIGCONTs the runner group when paused', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Resume target',
    });
    await saveRunner(ctx, {
      taskId: created.task.id,
      sessionId: 'sess-1',
      pid: 1234,
      pidStarttime: 'Fri Apr 25 10:00:00 2026',
      workflow: '.github/workflows/review.yml',
      startedAt: '2026-04-30T00:00:00.000Z',
      pausedAt: '2026-04-30T00:01:00.000Z',
    });
    const { signaller, signals } = makeSignaller();
    const result = await unpauseTaskHandler(ctx, {
      taskId: created.task.id,
      signaller,
    });
    expect(result.outcome.kind).toBe('resumed');
    expect(signals[0]?.signal).toBe('SIGCONT');
    expect(signals[0]?.target).toBe(-1234);
  });

  it('throws on missing task', async () => {
    const ctx = makeStoreContext();
    await expect(
      unpauseTaskHandler(ctx, {
        taskId: 'T-zzzzzzzzzz',
      }),
    ).rejects.toThrow();
  });
});
