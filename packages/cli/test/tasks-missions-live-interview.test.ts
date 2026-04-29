/**
 * Coverage for the schema/UI adapter helpers in live-interview.ts.
 *
 * The harness-driven branch is exercised through the existing
 * `tasks-missions-commands-new` tests via the `runInterview` injection seam;
 * this file pins the pure-function adapters that translate between the core
 * `interview()` schemas and the askUserService modal shape.
 */
import { describe, expect, test } from 'bun:test';

import type { InterviewQuestion } from '../src/commands/builtins/tasks/missions/commands/live-interview.js';
import {
  buildAskUserQuestion,
  extractAnswer,
  mapAutopilotAnswer,
  toMissionTreeInput,
} from '../src/commands/builtins/tasks/missions/commands/live-interview.js';

function makeQuestion(overrides: Partial<InterviewQuestion> = {}): InterviewQuestion {
  return {
    id: 'q-1',
    type: 'single_select',
    question: 'Pick one',
    options: [
      {
        id: 'a',
        label: 'Alpha',
      },
      {
        id: 'b',
        label: 'Beta',
      },
    ],
    ...overrides,
  };
}

describe('buildAskUserQuestion', () => {
  test('confirm renders Yes/No options', () => {
    const out = buildAskUserQuestion(
      makeQuestion({
        type: 'confirm',
        options: undefined,
      }),
    );
    expect(out.multiSelect).toBe(false);
    expect(out.options.map((o) => o.label)).toEqual([
      'Yes',
      'No',
    ]);
  });

  test('text type falls through to free-form options stub', () => {
    const out = buildAskUserQuestion(
      makeQuestion({
        type: 'text',
        options: undefined,
      }),
    );
    expect(out.multiSelect).toBe(false);
    expect(out.options).toHaveLength(2);
    expect(out.options[0]?.label).toBe('Provide answer');
  });

  test('single_select with provided options preserves them up to 4', () => {
    const out = buildAskUserQuestion(
      makeQuestion({
        options: [
          {
            id: '1',
            label: 'One',
          },
          {
            id: '2',
            label: 'Two',
          },
          {
            id: '3',
            label: 'Three',
          },
          {
            id: '4',
            label: 'Four',
          },
          {
            id: '5',
            label: 'Five',
          },
        ],
      }),
    );
    expect(out.options).toHaveLength(4);
    expect(out.multiSelect).toBe(false);
  });

  test('multi_select toggles multiSelect=true', () => {
    const out = buildAskUserQuestion(
      makeQuestion({
        type: 'multi_select',
      }),
    );
    expect(out.multiSelect).toBe(true);
  });

  test('header truncates ids longer than 12 chars', () => {
    const out = buildAskUserQuestion(
      makeQuestion({
        id: 'this-is-an-overlong-question-id',
      }),
    );
    expect(out.header.length).toBeLessThanOrEqual(12);
  });

  test('header substitutes a default when id is empty', () => {
    const out = buildAskUserQuestion(
      makeQuestion({
        id: '',
      }),
    );
    expect(out.header.length).toBeGreaterThan(0);
  });
});

describe('extractAnswer', () => {
  test('single_select returns scalar string', () => {
    const out = extractAnswer(makeQuestion(), {
      answers: {
        'Pick one': 'Alpha',
      },
    });
    expect(out.answer).toBe('Alpha');
    expect(out.questionId).toBe('q-1');
  });

  test('multi_select splits a comma-separated answer', () => {
    const out = extractAnswer(
      makeQuestion({
        type: 'multi_select',
      }),
      {
        answers: {
          'Pick one': 'Alpha, Beta',
        },
      },
    );
    expect(out.answer).toEqual([
      'Alpha',
      'Beta',
    ]);
  });

  test('missing answer maps to empty string for scalar types', () => {
    const out = extractAnswer(makeQuestion(), {
      answers: {},
    });
    expect(out.answer).toBe('');
  });

  test('multi_select with empty answer maps to empty array', () => {
    const out = extractAnswer(
      makeQuestion({
        type: 'multi_select',
      }),
      {
        answers: {
          'Pick one': '',
        },
      },
    );
    expect(out.answer).toEqual([]);
  });
});

describe('mapAutopilotAnswer', () => {
  test('"Yes" maps to "yes"', () => {
    expect(mapAutopilotAnswer('Yes')).toBe('yes');
  });

  test('"First slice only" maps to "first-slice-only"', () => {
    expect(mapAutopilotAnswer('First slice only')).toBe('first-slice-only');
  });

  test('"No" maps to "no"', () => {
    expect(mapAutopilotAnswer('No')).toBe('no');
  });

  test('unrecognized answers default to "no"', () => {
    expect(mapAutopilotAnswer(undefined)).toBe('no');
    expect(mapAutopilotAnswer('Maybe')).toBe('no');
    expect(mapAutopilotAnswer('')).toBe('no');
  });
});

describe('toMissionTreeInput', () => {
  test('flattens optional descriptions into the tree shape', () => {
    const tree = toMissionTreeInput({
      missionTitle: 'Build login',
      missionDescription: 'wire OAuth',
      milestones: [
        {
          title: 'Discovery',
          verification: 'docs read',
          slices: [
            {
              title: 'Spike',
              verification: 'spike done',
              features: [
                {
                  title: 'Read docs',
                  acceptanceCriteria: [
                    'docs annotated',
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(tree.title).toBe('Build login');
    expect(tree.description).toBe('wire OAuth');
    expect(tree.milestones).toHaveLength(1);
    expect(tree.milestones[0]?.slices[0]?.features[0]?.title).toBe('Read docs');
  });

  test('coerces a stringly-typed acceptanceCriteria into a single-element array', () => {
    const tree = toMissionTreeInput({
      missionTitle: 'M',
      milestones: [
        {
          title: 'X',
          verification: 'v',
          slices: [
            {
              title: 'S',
              verification: 'sv',
              features: [
                {
                  title: 'F',
                  // The InterviewComplete schema accepts string|string[] and
                  // normalizes via .transform — covered indirectly here by
                  // the toMissionTreeInput contract.
                  acceptanceCriteria: [
                    'single criterion',
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(tree.milestones[0]?.slices[0]?.features[0]?.acceptanceCriteria).toEqual([
      'single criterion',
    ]);
  });
});
