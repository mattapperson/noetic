import { describe, expect, it } from 'bun:test';
import type { InterviewQuestion } from '../../../src/tasks/runtime/hierarchy/live-interview.js';
import {
  buildAskUserQuestion,
  closeInterviewSession,
  ensureInterviewSession,
  extractAnswer,
  mapAutopilotAnswer,
  toInterviewResultLike,
  toTaskHierarchyInput,
} from '../../../src/tasks/runtime/hierarchy/live-interview.js';
import { InterviewSessionStatus } from '../../../src/tasks/runtime/hierarchy/schemas.js';
import { loadInterviewSession } from '../../../src/tasks/runtime/hierarchy/store.js';
import { makeStoreContext } from '../_helpers.js';

const TASK_ID = 'T-abcdefghij';

//#region buildAskUserQuestion

describe('buildAskUserQuestion', () => {
  it('renders a confirm envelope as a Yes/No multi-select=false set', () => {
    const ask = buildAskUserQuestion({
      id: 'q-1',
      type: 'confirm',
      question: 'Sure?',
    });
    expect(ask.multiSelect).toBe(false);
    expect(ask.options.map((o) => o.label)).toEqual([
      'Yes',
      'No',
    ]);
  });

  it('renders text envelopes with Provide answer / Skip', () => {
    const ask = buildAskUserQuestion({
      id: 'q-2',
      type: 'text',
      question: 'Name?',
    });
    expect(ask.options.map((o) => o.label)).toEqual([
      'Provide answer',
      'Skip',
    ]);
  });

  it('clamps to 4 options for single_select', () => {
    const ask = buildAskUserQuestion({
      id: 'q-3',
      type: 'single_select',
      question: 'Pick',
      options: [
        {
          id: 'a',
          label: 'A',
        },
        {
          id: 'b',
          label: 'B',
        },
        {
          id: 'c',
          label: 'C',
        },
        {
          id: 'd',
          label: 'D',
        },
        {
          id: 'e',
          label: 'E',
        },
      ],
    });
    expect(ask.options).toHaveLength(4);
    expect(ask.multiSelect).toBe(false);
  });

  it('marks multi_select envelopes as multi-select', () => {
    const ask = buildAskUserQuestion({
      id: 'q-4',
      type: 'multi_select',
      question: 'Pick all',
      options: [
        {
          id: 'a',
          label: 'A',
        },
      ],
    });
    expect(ask.multiSelect).toBe(true);
  });
});

//#endregion

//#region extractAnswer

describe('extractAnswer', () => {
  const env: InterviewQuestion = {
    id: 'q-1',
    type: 'single_select',
    question: 'Pick one?',
  };

  it('returns scalar answer for single_select', () => {
    const answer = extractAnswer(env, {
      answers: {
        'Pick one?': 'B',
      },
    });
    expect(answer.answer).toBe('B');
  });

  it('parses comma-separated values for multi_select', () => {
    const answer = extractAnswer(
      {
        ...env,
        type: 'multi_select',
      },
      {
        answers: {
          'Pick one?': ' A, B , C ',
        },
      },
    );
    expect(answer.answer).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('falls back to empty string when key missing', () => {
    const answer = extractAnswer(env, {
      answers: {},
    });
    expect(answer.answer).toBe('');
  });
});

//#endregion

//#region toTaskHierarchyInput

describe('toTaskHierarchyInput', () => {
  it('collapses string-array acceptanceCriteria into a newline-joined string', () => {
    const input = toTaskHierarchyInput({
      milestones: [
        {
          title: 'M',
          verification: 'v',
          slices: [
            {
              title: 'S',
              verification: 's',
              features: [
                {
                  title: 'F',
                  acceptanceCriteria: [
                    'a',
                    '',
                    'b',
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const feature = input.milestones[0]?.slices[0]?.features[0];
    expect(feature?.acceptanceCriteria).toBe('a\nb');
  });

  it('passes a string acceptanceCriteria through verbatim', () => {
    const input = toTaskHierarchyInput({
      milestones: [
        {
          title: 'M',
          verification: 'v',
          slices: [
            {
              title: 'S',
              verification: 's',
              features: [
                {
                  title: 'F',
                  acceptanceCriteria: 'one criterion',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(input.milestones[0]?.slices[0]?.features[0]?.acceptanceCriteria).toBe('one criterion');
  });

  it('defaults missing optional fields to null and empty arrays', () => {
    const input = toTaskHierarchyInput({
      milestones: [
        {
          title: 'M',
          verification: 'v',
          slices: [],
        },
      ],
    });
    expect(input.milestones[0]?.description).toBeNull();
    expect(input.milestones[0]?.assertions).toEqual([]);
  });
});

//#endregion

//#region toInterviewResultLike

describe('toInterviewResultLike', () => {
  it('passes through a complete result, normalising the envelope', () => {
    const result = toInterviewResultLike({
      status: 'complete',
      envelope: {
        milestones: [],
      },
    });
    expect(result.status).toBe('complete');
  });

  it('annotates a maxQuestions result with a reason', () => {
    const result = toInterviewResultLike({
      status: 'maxQuestions',
      lastQuestion: {
        id: 'q-1',
        type: 'text',
        question: 'final',
      },
      // The core's InterviewResult shape includes the question budget; tests
      // only depend on the shape we re-emit.
    });
    if (result.status !== 'maxQuestions') {
      throw new Error('expected maxQuestions');
    }
    expect(result.lastQuestion?.id).toBe('q-1');
    expect(result.reason?.length ?? 0).toBeGreaterThan(0);
  });
});

//#endregion

//#region mapAutopilotAnswer

describe('mapAutopilotAnswer', () => {
  it("maps 'Yes' to 'yes'", () => {
    expect(mapAutopilotAnswer('Yes')).toBe('yes');
  });

  it("maps 'First slice only' to 'first-slice-only'", () => {
    expect(mapAutopilotAnswer('First slice only')).toBe('first-slice-only');
  });

  it("defaults to 'no' for any other answer", () => {
    expect(mapAutopilotAnswer('No')).toBe('no');
    expect(mapAutopilotAnswer(undefined)).toBe('no');
    expect(mapAutopilotAnswer('garbage')).toBe('no');
  });
});

//#endregion

//#region session persistence

describe('ensureInterviewSession', () => {
  it('creates and persists a fresh active session', async () => {
    const ctx = makeStoreContext();
    const session = await ensureInterviewSession(ctx, TASK_ID);
    expect(session.status).toBe(InterviewSessionStatus.Active);
    const reloaded = await loadInterviewSession(ctx, TASK_ID, session.id);
    expect(reloaded?.id).toBe(session.id);
    expect(reloaded?.status).toBe(InterviewSessionStatus.Active);
  });
});

describe('closeInterviewSession', () => {
  it('marks an existing session complete and observes via reload', async () => {
    const ctx = makeStoreContext();
    const session = await ensureInterviewSession(ctx, TASK_ID);
    await closeInterviewSession(ctx, {
      taskId: TASK_ID,
      sessionId: session.id,
      status: 'complete',
      state: {
        finalEnvelope: 'x',
      },
    });
    const reloaded = await loadInterviewSession(ctx, TASK_ID, session.id);
    expect(reloaded?.status).toBe(InterviewSessionStatus.Complete);
    expect(reloaded?.state).toEqual({
      finalEnvelope: 'x',
    });
  });

  it('marks a session cancelled when status=cancelled', async () => {
    const ctx = makeStoreContext();
    const session = await ensureInterviewSession(ctx, TASK_ID);
    const closed = await closeInterviewSession(ctx, {
      taskId: TASK_ID,
      sessionId: session.id,
      status: 'cancelled',
    });
    expect(closed.status).toBe(InterviewSessionStatus.Cancelled);
  });

  it('throws when the session does not exist', async () => {
    const ctx = makeStoreContext();
    await expect(
      closeInterviewSession(ctx, {
        taskId: TASK_ID,
        sessionId: 'IV-zzzzzzzzzz',
        status: 'complete',
      }),
    ).rejects.toThrow(/not found/);
  });
});

//#endregion
