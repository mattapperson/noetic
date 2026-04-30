import { describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';

import type { MissionRecord } from '../src/commands/builtins/tasks/db/schema.js';
import type {
  AutopilotChoice,
  InterviewCompleteEnvelope,
  InterviewResultLike,
  Phase,
} from '../src/commands/builtins/tasks/missions/commands/new.js';
import { driveMissionNew } from '../src/commands/builtins/tasks/missions/commands/new.js';
import type { MissionTreeInput } from '../src/commands/builtins/tasks/missions/store.js';

interface FakeRunResult {
  phases: Phase[];
  doneCalls: Array<unknown>;
  ensureCalls: Array<string>;
  persistCalls: Array<{
    cwd: string;
    tree: MissionTreeInput;
  }>;
  updateCalls: Array<{
    cwd: string;
    id: string;
    patch: Partial<MissionRecord>;
  }>;
}

function makeMission(overrides: Partial<MissionRecord> = {}): MissionRecord {
  const now = new Date().toISOString();
  return {
    id: 'mission-id',
    title: 'A',
    description: null,
    status: 'planning',
    interviewState: null,
    autopilotEnabled: false,
    autopilotState: 'inactive',
    lastAutopilotActivityAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeTree(): InterviewCompleteEnvelope {
  return {
    title: 'Mission Alpha',
    description: 'desc',
    milestones: [
      {
        title: 'M1',
        verification: 'verify',
        slices: [
          {
            title: 'S1',
            verification: 'sv',
            features: [
              {
                title: 'F1',
                acceptanceCriteria: [
                  'a1',
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

interface RunOpts {
  result: InterviewResultLike;
  autopilotChoice: AutopilotChoice;
  cancelBeforeFinish?: 'after-interview' | 'after-autopilot' | undefined;
}

async function runDrive(opts: RunOpts): Promise<FakeRunResult> {
  const phases: Phase[] = [];
  const doneCalls: Array<unknown> = [];
  const ensureCalls: string[] = [];
  const persistCalls: FakeRunResult['persistCalls'] = [];
  const updateCalls: FakeRunResult['updateCalls'] = [];

  const session = {
    cancelled: false,
  };

  await driveMissionNew({
    session,
    cwd: '/tmp/cwd',
    runInterview: async () => {
      if (opts.cancelBeforeFinish === 'after-interview') {
        session.cancelled = true;
      }
      return opts.result;
    },
    askAutopilot: async () => {
      if (opts.cancelBeforeFinish === 'after-autopilot') {
        session.cancelled = true;
      }
      return opts.autopilotChoice;
    },
    ensureDaemonFn: (cwd) => {
      ensureCalls.push(cwd);
    },
    persistMissionTreeFn: (cwd, tree) => {
      persistCalls.push({
        cwd,
        tree,
      });
      return makeMission({
        title: tree.title,
      });
    },
    updateMissionFn: (cwd, id, patch) => {
      updateCalls.push({
        cwd,
        id,
        patch,
      });
      return makeMission({
        ...patch,
        id,
      });
    },
    onDone: (msg) => {
      doneCalls.push(msg);
    },
    setPhase: (phase) => {
      phases.push(phase);
    },
  });
  return {
    phases,
    doneCalls,
    ensureCalls,
    persistCalls,
    updateCalls,
  };
}

describe('driveMissionNew', () => {
  test('complete branch persists, prompts for autopilot, calls onDone with summary', async () => {
    const result = await runDrive({
      result: {
        status: 'complete',
        envelope: makeTree(),
      },
      autopilotChoice: 'no',
    });
    expect(result.persistCalls).toHaveLength(1);
    expect(result.persistCalls[0]?.tree.title).toBe('Mission Alpha');
    expect(result.updateCalls).toHaveLength(0);
    expect(result.ensureCalls).toHaveLength(0);
    const summary = result.doneCalls[0];
    assert.equal(typeof summary, 'string');
    expect(summary).toContain('Mission "Mission Alpha" created');
    expect(summary).not.toContain('Autopilot enabled');
  });

  test('complete + autopilot=yes enables autopilot and ensures daemon', async () => {
    const result = await runDrive({
      result: {
        status: 'complete',
        envelope: makeTree(),
      },
      autopilotChoice: 'yes',
    });
    expect(result.updateCalls).toHaveLength(1);
    expect(result.updateCalls[0]?.patch.autopilotEnabled).toBe(true);
    expect(result.updateCalls[0]?.patch.autopilotState).toBe('watching');
    expect(result.ensureCalls).toHaveLength(1);
    expect(result.doneCalls[0]).toContain('Autopilot enabled');
  });

  test('complete + autopilot=first-slice-only also enables autopilot', async () => {
    const result = await runDrive({
      result: {
        status: 'complete',
        envelope: makeTree(),
      },
      autopilotChoice: 'first-slice-only',
    });
    expect(result.updateCalls).toHaveLength(1);
    expect(result.ensureCalls).toHaveLength(1);
  });

  test('maxQuestions branch does not persist; calls onDone with cancellation reason', async () => {
    const result = await runDrive({
      result: {
        status: 'maxQuestions',
        lastQuestion: {
          id: 'q-9',
          type: 'single_select',
          question: 'What is the deployment story?',
        },
        reason: 'Budget exhausted.',
      },
      autopilotChoice: 'no',
    });
    expect(result.persistCalls).toHaveLength(0);
    expect(result.updateCalls).toHaveLength(0);
    expect(result.ensureCalls).toHaveLength(0);
    const finalPhase = result.phases[result.phases.length - 1];
    assert.ok(finalPhase);
    expect(finalPhase.kind).toBe('maxQuestions');
    const message = result.doneCalls[0];
    assert.equal(typeof message, 'string');
    expect(message).toContain('did not complete');
    expect(message).toContain('What is the deployment story?');
  });

  test('maxQuestions branch with no lastQuestion uses fallback reason', async () => {
    const result = await runDrive({
      result: {
        status: 'maxQuestions',
      },
      autopilotChoice: 'no',
    });
    const message = result.doneCalls[0];
    assert.equal(typeof message, 'string');
    expect(message).toContain('did not complete');
  });

  test('cancellation after interview short-circuits before persist', async () => {
    const result = await runDrive({
      result: {
        status: 'complete',
        envelope: makeTree(),
      },
      autopilotChoice: 'no',
      cancelBeforeFinish: 'after-interview',
    });
    expect(result.persistCalls).toHaveLength(0);
    expect(result.doneCalls).toHaveLength(0);
  });

  test('cancellation after autopilot prompt short-circuits before update/ensureDaemon', async () => {
    const result = await runDrive({
      result: {
        status: 'complete',
        envelope: makeTree(),
      },
      autopilotChoice: 'yes',
      cancelBeforeFinish: 'after-autopilot',
    });
    expect(result.persistCalls).toHaveLength(1);
    expect(result.updateCalls).toHaveLength(0);
    expect(result.ensureCalls).toHaveLength(0);
  });

  test('phase transitions advance running → persisting → completing on the happy path', async () => {
    const result = await runDrive({
      result: {
        status: 'complete',
        envelope: makeTree(),
      },
      autopilotChoice: 'no',
    });
    const kinds = result.phases.map((p) => p.kind);
    expect(kinds).toContain('persisting');
    expect(kinds).toContain('completing');
  });
});
