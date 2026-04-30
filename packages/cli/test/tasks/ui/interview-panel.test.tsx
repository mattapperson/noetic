/**
 * Coverage for the interview-panel state machine. We exercise:
 *
 * 1. The `complete` happy path: phases run → persisting → done; persist
 *    is called with the envelope; `onDone` reports the milestone count.
 * 2. The `maxQuestions` branch: persist is *not* called; the summary
 *    embeds the last unanswered question.
 * 3. Cancellation after `runInterview` resolves: nothing further happens.
 * 4. Cancellation after persistence: persist completes but `onDone` is
 *    skipped.
 * 5. Errors in `runInterview` and `persist` both surface as `error`
 *    phases.
 *
 * `formatMaxQuestionsSummary` and `describePhase` are also covered for
 * their formatting branches.
 */

import { describe, expect, test } from 'bun:test';

import type { InterviewResultLike } from '../../../src/commands/builtins/tasks/hierarchy/live-interview.js';
import type { Phase } from '../../../src/commands/builtins/tasks/ui/interview-panel.js';
import {
  describePhase,
  drivePlanInterview,
  formatMaxQuestionsSummary,
} from '../../../src/commands/builtins/tasks/ui/interview-panel.js';

//#region Helpers

interface DriveResult {
  phases: Phase[];
  doneCalls: string[];
  persistCalls: number;
}

interface DriveOpts {
  result: InterviewResultLike;
  cancelAfter?: 'interview' | 'persist';
  runInterviewThrows?: string;
  persistThrows?: string;
}

async function runDrive(opts: DriveOpts): Promise<DriveResult> {
  const phases: Phase[] = [];
  const doneCalls: string[] = [];
  let persistCalls = 0;
  const session = {
    cancelled: false,
  };

  await drivePlanInterview({
    session,
    runInterview: async () => {
      if (opts.runInterviewThrows !== undefined) {
        throw new Error(opts.runInterviewThrows);
      }
      if (opts.cancelAfter === 'interview') {
        session.cancelled = true;
      }
      return opts.result;
    },
    persist: async () => {
      persistCalls += 1;
      if (opts.persistThrows !== undefined) {
        throw new Error(opts.persistThrows);
      }
      if (opts.cancelAfter === 'persist') {
        session.cancelled = true;
      }
    },
    setPhase: (phase) => {
      phases.push(phase);
    },
    onDone: (msg) => {
      doneCalls.push(msg);
    },
  });

  return {
    phases,
    doneCalls,
    persistCalls,
  };
}

function makeCompleteResult(milestones = 1): InterviewResultLike {
  return {
    status: 'complete',
    envelope: {
      milestones: Array.from(
        {
          length: milestones,
        },
        (_unused, i) => ({
          title: `M${i}`,
          description: null,
          verification: 'verify',
          slices: [],
          assertions: [],
        }),
      ),
    },
  };
}

//#endregion

describe('drivePlanInterview', () => {
  test('happy path: phases run → persisting → done; onDone fires', async () => {
    const r = await runDrive({
      result: makeCompleteResult(2),
    });
    const kinds = r.phases.map((p) => p.kind);
    expect(kinds).toEqual([
      'running',
      'persisting',
      'done',
    ]);
    expect(r.persistCalls).toBe(1);
    expect(r.doneCalls).toHaveLength(1);
    expect(r.doneCalls[0]).toContain('2 milestones');
  });

  test('happy path with single milestone: summary uses singular noun', async () => {
    const r = await runDrive({
      result: makeCompleteResult(1),
    });
    expect(r.doneCalls[0]).toContain('1 milestone');
    expect(r.doneCalls[0]).not.toContain('milestones');
  });

  test('maxQuestions: persist is not called and summary embeds the last question', async () => {
    const r = await runDrive({
      result: {
        status: 'maxQuestions',
        lastQuestion: {
          id: 'q-9',
          type: 'single_select',
          question: 'What is the deployment story?',
        },
        reason: 'Budget exhausted.',
      },
    });
    expect(r.persistCalls).toBe(0);
    expect(r.phases.map((p) => p.kind)).toEqual([
      'running',
      'done',
    ]);
    expect(r.doneCalls[0]).toContain('What is the deployment story?');
    expect(r.doneCalls[0]).toContain('Budget exhausted.');
  });

  test('cancellation after the interview short-circuits before persisting', async () => {
    const r = await runDrive({
      result: makeCompleteResult(),
      cancelAfter: 'interview',
    });
    expect(r.persistCalls).toBe(0);
    expect(r.doneCalls).toHaveLength(0);
    expect(r.phases.map((p) => p.kind)).toEqual([
      'running',
    ]);
  });

  test('cancellation after persistence skips onDone but persist did run', async () => {
    const r = await runDrive({
      result: makeCompleteResult(),
      cancelAfter: 'persist',
    });
    expect(r.persistCalls).toBe(1);
    expect(r.doneCalls).toHaveLength(0);
    expect(r.phases.map((p) => p.kind)).toEqual([
      'running',
      'persisting',
    ]);
  });

  test('runInterview throwing surfaces an error phase', async () => {
    const r = await runDrive({
      result: makeCompleteResult(),
      runInterviewThrows: 'LLM died',
    });
    const last = r.phases[r.phases.length - 1];
    expect(last?.kind).toBe('error');
    expect(r.persistCalls).toBe(0);
  });

  test('persist throwing surfaces an error phase', async () => {
    const r = await runDrive({
      result: makeCompleteResult(),
      persistThrows: 'disk full',
    });
    const last = r.phases[r.phases.length - 1];
    expect(last?.kind).toBe('error');
    expect(r.persistCalls).toBe(1);
  });
});

describe('formatMaxQuestionsSummary', () => {
  test('embeds the last question when present', () => {
    const text = formatMaxQuestionsSummary({
      status: 'maxQuestions',
      lastQuestion: {
        id: 'q-1',
        type: 'text',
        question: 'How will users authenticate?',
      },
      reason: 'Out of budget.',
    });
    expect(text).toContain('Out of budget.');
    expect(text).toContain('How will users authenticate?');
  });

  test('falls back to the default reason when none is supplied', () => {
    const text = formatMaxQuestionsSummary({
      status: 'maxQuestions',
    });
    expect(text).toContain('Interview did not complete.');
  });
});

describe('describePhase', () => {
  test('formats every phase variant', () => {
    expect(
      describePhase({
        kind: 'idle',
      }),
    ).toContain('Ready');
    expect(
      describePhase({
        kind: 'running',
      }),
    ).toContain('Asking');
    expect(
      describePhase({
        kind: 'persisting',
      }),
    ).toContain('Saving');
    expect(
      describePhase({
        kind: 'done',
        summary: 'all good',
      }),
    ).toBe('all good');
    expect(
      describePhase({
        kind: 'error',
        message: 'boom',
      }),
    ).toContain('boom');
  });
});
