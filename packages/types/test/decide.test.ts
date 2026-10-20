import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import {
  choiceValues,
  DecideOutputError,
  DecideQuestionSchema,
  DecideQuestionsSchema,
  routeOutcomes,
  scoreLevels,
  WorkflowNodeSchema,
  workflowGraph,
} from '../src/index';

describe('decide question schemas', () => {
  test('accepts each question type at its limits', () => {
    const ok = [
      {
        type: 'boolean',
        instructions: 'Urgent?',
      },
      {
        type: 'boolean',
        criteria: {
          false: 'Calm',
        },
      },
      {
        type: 'choice',
        choices: [
          'only',
        ],
      },
      {
        type: 'choice',
        choices: Array.from(
          {
            length: 255,
          },
          (_u, i) => `c${i}`,
        ),
      },
      {
        type: 'score',
        levels: [
          'low',
          'high',
        ],
      },
      {
        type: 'score',
        levels: Array.from(
          {
            length: 10,
          },
          (_u, i) => ({
            label: `l${i}`,
          }),
        ),
      },
      {
        type: 'boolean',
        instructions: 'x',
        threshold: 0,
      },
      {
        type: 'boolean',
        instructions: 'x',
        threshold: 1,
      },
    ];
    for (const q of ok) {
      expect(DecideQuestionSchema.safeParse(q).success).toBe(true);
    }
  });

  test('rejects questions past their limits', () => {
    const bad = [
      {
        type: 'boolean',
      },
      {
        type: 'choice',
        choices: Array.from(
          {
            length: 256,
          },
          (_u, i) => `c${i}`,
        ),
      },
      {
        type: 'choice',
        choices: {},
      },
      {
        type: 'score',
        levels: [
          'one',
        ],
      },
      {
        type: 'score',
        levels: Array.from(
          {
            length: 11,
          },
          (_u, i) => `l${i}`,
        ),
      },
      {
        type: 'score',
        levels: [
          'same',
          'same',
        ],
      },
      {
        type: 'boolean',
        instructions: 'x',
        threshold: 1.01,
      },
    ];
    for (const q of bad) {
      expect(DecideQuestionSchema.safeParse(q).success).toBe(false);
    }
  });

  test('a question map needs at least one question', () => {
    expect(DecideQuestionsSchema.safeParse({}).success).toBe(false);
  });
});

describe('decide helpers', () => {
  test('choiceValues reads arrays and records in declaration order', () => {
    expect(
      choiceValues([
        'b',
        'a',
      ]),
    ).toEqual([
      'b',
      'a',
    ]);
    expect(
      choiceValues({
        b: 'Bee',
        a: 'Ay',
      }),
    ).toEqual([
      'b',
      'a',
    ]);
  });

  test('scoreLevels turns bare labels into objects and keeps object levels', () => {
    expect(
      scoreLevels([
        'low',
        'high',
      ]),
    ).toEqual([
      {
        label: 'low',
      },
      {
        label: 'high',
      },
    ]);
    expect(
      scoreLevels([
        {
          label: 'high',
          description: 'Now',
        },
      ]),
    ).toEqual([
      {
        label: 'high',
        description: 'Now',
      },
    ]);
  });

  test('routeOutcomes lists the case keys each question type routes to', () => {
    expect(
      routeOutcomes({
        type: 'boolean',
        instructions: 'x',
      }),
    ).toEqual([
      'true',
      'false',
    ]);
    expect(
      routeOutcomes({
        type: 'choice',
        choices: {
          a: 'A',
        },
      }),
    ).toEqual([
      'a',
    ]);
    expect(
      routeOutcomes({
        type: 'score',
        levels: [
          'low',
          'high',
        ],
      }),
    ).toEqual([
      'low',
      'high',
    ]);
  });

  test('DecideOutputError carries the raw text for the parse error', () => {
    const parsed = DecideQuestionsSchema.safeParse({});
    assert(!parsed.success);
    const error = new DecideOutputError({
      raw: 'garbage',
      schema: DecideQuestionsSchema,
      zodError: parsed.error,
    });
    expect(error.name).toBe('DecideOutputError');
    expect(error.raw).toBe('garbage');
  });
});

describe('routeSwitch workflow node', () => {
  const decide = {
    kind: 'decide',
    id: 'triage',
    questions: {
      urgent: {
        type: 'boolean',
        instructions: 'Urgent?',
      },
    },
  };
  const leaf = (id: string) => ({
    kind: 'llm',
    id,
    instructions: id,
  });

  test('validates when cases cover every outcome', () => {
    const node = {
      kind: 'routeSwitch',
      id: 'route',
      decide,
      on: 'urgent',
      cases: {
        true: leaf('page'),
        false: leaf('queue'),
      },
      uncertain: leaf('ask'),
    };
    expect(WorkflowNodeSchema.safeParse(node).success).toBe(true);
  });

  test('rejects an unknown question, a missing case, a prototype-named question, and a missing uncertain', () => {
    const base = {
      kind: 'routeSwitch',
      id: 'route',
      decide,
      on: 'urgent',
      cases: {
        true: leaf('page'),
        false: leaf('queue'),
      },
      uncertain: leaf('ask'),
    };
    const bad = [
      {
        ...base,
        on: 'nope',
      },
      {
        ...base,
        cases: {
          true: leaf('page'),
        },
      },
      {
        ...base,
        on: 'constructor',
      },
      {
        ...base,
        uncertain: undefined,
      },
    ];
    for (const node of bad) {
      expect(WorkflowNodeSchema.safeParse(node).success).toBe(false);
    }
  });

  test('workflowGraph walks the decide node, every case, and uncertain', () => {
    const node = WorkflowNodeSchema.parse({
      kind: 'routeSwitch',
      id: 'route',
      decide,
      on: 'urgent',
      cases: {
        true: leaf('page'),
        false: leaf('queue'),
      },
      minConfidence: 0.6,
      uncertain: leaf('ask'),
    });
    expect(workflowGraph(node).edges).toEqual([
      {
        from: 'route',
        to: 'triage',
      },
      {
        from: 'route',
        to: 'page',
      },
      {
        from: 'route',
        to: 'queue',
      },
      {
        from: 'route',
        to: 'ask',
      },
    ]);
  });
});
