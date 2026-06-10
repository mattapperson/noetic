import { describe, expect, test } from 'bun:test';
import type { Step } from '@noetic-tools/core';
import { step } from '@noetic-tools/core';

import {
  createGepaAdapter,
  extractBestCandidate,
  parseFieldText,
  serializeFields,
} from '../../src/optimization/gepa-bridge';
import type { Candidate, OptimizableField } from '../../src/types/optimizer';
import { FieldKind } from '../../src/types/optimizer';

//#region Constants

const COMPONENT_ID = 'root::instruction';
const INSTRUCTIONS_PATH = 'agent.instructions';

//#endregion

//#region Helper Functions

function makeFields(): OptimizableField[] {
  return [
    {
      path: INSTRUCTIONS_PATH,
      value: 'original instructions',
      stepId: 'agent',
      fieldKind: FieldKind.Instructions,
    },
    {
      path: 'agent.tools.search.description',
      value: 'original tool description',
      stepId: 'agent',
      fieldKind: FieldKind.ToolDescription,
    },
  ];
}

function makeLlmStep(): Step {
  return step.llm({
    id: 'agent',
    model: 'openai/gpt-4o-mini',
    instructions: 'original instructions',
  });
}

function instructionsOf(s: Step): string | undefined {
  if (s.kind !== 'llm') {
    return undefined;
  }
  return typeof s.instructions === 'string' ? s.instructions : undefined;
}

//#endregion

//#region Serialization Round-trip

describe('serializeFields / parseFieldText', () => {
  test('round-trips simple values', () => {
    const candidate: Candidate = {
      a: 'one',
      b: 'two',
    };
    const text = serializeFields(candidate, [
      'a',
      'b',
    ]);
    expect(parseFieldText(text)).toEqual(candidate);
  });

  test('round-trips multiline values with backticks and interpolation syntax', () => {
    const candidate: Candidate = {
      [INSTRUCTIONS_PATH]: [
        'Line one with `backticks`',
        'Line two with $' + '{interpolation}',
        '',
        'Line four after a blank line',
      ].join('\n'),
    };
    const text = serializeFields(candidate, [
      INSTRUCTIONS_PATH,
    ]);
    expect(parseFieldText(text)).toEqual(candidate);
  });

  test('round-trips values containing marker-LIKE (but not exact) lines', () => {
    const candidate: Candidate = {
      a: '== NOETIC FIELD fake ==\n=== END NOETIC FIELD ===extra\nstill the same value',
    };
    const text = serializeFields(candidate, [
      'a',
    ]);
    expect(parseFieldText(text)).toEqual(candidate);
  });

  test('value embedding an exact end-marker line fails closed (undefined)', () => {
    const candidate: Candidate = {
      a: 'prefix\n=== END NOETIC FIELD ===\nsuffix',
    };
    const text = serializeFields(candidate, [
      'a',
    ]);
    expect(parseFieldText(text)).toBeUndefined();
  });

  test('free-form text (destroyed markers) parses to undefined', () => {
    expect(parseFieldText('Here is an improved prompt:\nBe more helpful.')).toBeUndefined();
    expect(parseFieldText('')).toBeUndefined();
  });

  test('unterminated block parses to undefined', () => {
    const text = '=== NOETIC FIELD a ===\nvalue without end marker';
    expect(parseFieldText(text)).toBeUndefined();
  });

  test('fields absent from the candidate are skipped during serialization', () => {
    const text = serializeFields(
      {
        a: 'one',
      },
      [
        'a',
        'missing',
      ],
    );
    expect(parseFieldText(text)).toEqual({
      a: 'one',
    });
  });
});

//#endregion

//#region Adapter evaluate()

describe('createGepaAdapter evaluate', () => {
  test('parses candidate text and evaluates the MUTATED step', async () => {
    const fields = makeFields();
    let receivedStep: Step | undefined;
    const adapter = createGepaAdapter({
      step: makeLlmStep(),
      fields,
      runEval: async (s) => {
        receivedStep = s;
        return {
          'case.scorer': 0.5,
        };
      },
      componentId: COMPONENT_ID,
      proposeFieldValue: async ({ currentValue }) => currentValue,
    });

    const improved: Candidate = {
      [INSTRUCTIONS_PATH]: 'improved instructions',
      'agent.tools.search.description': 'improved tool description',
    };
    const text = serializeFields(
      improved,
      fields.map((f) => f.path),
    );

    const batch = await adapter.evaluate(
      [
        {
          index: 0,
        },
      ],
      {
        [COMPONENT_ID]: text,
      },
    );

    expect(receivedStep).toBeDefined();
    if (!receivedStep) {
      throw new Error('runEval never invoked');
    }
    expect(instructionsOf(receivedStep)).toBe('improved instructions');
    expect(batch.scores).toEqual([
      0.5,
    ]);
  });

  test('destroyed markers evaluate the ORIGINAL step', async () => {
    const original = makeLlmStep();
    let receivedStep: Step | undefined;
    const adapter = createGepaAdapter({
      step: original,
      fields: makeFields(),
      runEval: async (s) => {
        receivedStep = s;
        return {
          'case.scorer': 0.1,
        };
      },
      componentId: COMPONENT_ID,
      proposeFieldValue: async ({ currentValue }) => currentValue,
    });

    await adapter.evaluate(
      [
        {
          index: 0,
        },
      ],
      {
        [COMPONENT_ID]: 'GEPA rewrote this text and destroyed the markers',
      },
    );

    expect(receivedStep).toBe(original);
  });

  test('missing component key evaluates the original step', async () => {
    const original = makeLlmStep();
    let receivedStep: Step | undefined;
    const adapter = createGepaAdapter({
      step: original,
      fields: makeFields(),
      runEval: async (s) => {
        receivedStep = s;
        return {};
      },
      componentId: COMPONENT_ID,
      proposeFieldValue: async ({ currentValue }) => currentValue,
    });

    await adapter.evaluate(
      [
        {
          index: 0,
        },
      ],
      {
        'some-other-component': 'text',
      },
    );

    expect(receivedStep).toBe(original);
  });
});

//#endregion

//#region Adapter propose_new_texts

describe('createGepaAdapter propose_new_texts', () => {
  test('teacher proposals are reassembled into valid marker text', async () => {
    const fields = makeFields();
    const fieldOrder = fields.map((f) => f.path);
    const adapter = createGepaAdapter({
      step: makeLlmStep(),
      fields,
      runEval: async () => ({}),
      componentId: COMPONENT_ID,
      proposeFieldValue: async ({ currentValue }) => `${currentValue} (improved)`,
    });

    if (!adapter.propose_new_texts) {
      throw new Error('propose_new_texts must be implemented');
    }
    const currentText = serializeFields(
      {
        [INSTRUCTIONS_PATH]: 'original instructions',
        'agent.tools.search.description': 'original tool description',
      },
      fieldOrder,
    );
    const result = await adapter.propose_new_texts(
      {
        [COMPONENT_ID]: currentText,
      },
      {
        [COMPONENT_ID]: [
          {
            feedback: 'Current score: 0.10.',
          },
        ],
      },
      [
        COMPONENT_ID,
      ],
    );

    const parsed = parseFieldText(result[COMPONENT_ID]);
    expect(parsed).toEqual({
      [INSTRUCTIONS_PATH]: 'original instructions (improved)',
      'agent.tools.search.description': 'original tool description (improved)',
    });
  });

  test('a throwing proposer falls back to the current value per field', async () => {
    const fields = makeFields();
    const adapter = createGepaAdapter({
      step: makeLlmStep(),
      fields,
      runEval: async () => ({}),
      componentId: COMPONENT_ID,
      proposeFieldValue: async ({ path, currentValue }) => {
        if (path === INSTRUCTIONS_PATH) {
          throw new Error('teacher unavailable');
        }
        return `${currentValue} v2`;
      },
    });

    if (!adapter.propose_new_texts) {
      throw new Error('propose_new_texts must be implemented');
    }
    const result = await adapter.propose_new_texts(
      {
        [COMPONENT_ID]: serializeFields(
          {
            [INSTRUCTIONS_PATH]: 'original instructions',
            'agent.tools.search.description': 'original tool description',
          },
          fields.map((f) => f.path),
        ),
      },
      {},
      [
        COMPONENT_ID,
      ],
    );

    expect(parseFieldText(result[COMPONENT_ID])).toEqual({
      [INSTRUCTIONS_PATH]: 'original instructions',
      'agent.tools.search.description': 'original tool description v2',
    });
  });

  test('unparseable current candidate falls back to initial field values', async () => {
    const fields = makeFields();
    const adapter = createGepaAdapter({
      step: makeLlmStep(),
      fields,
      runEval: async () => ({}),
      componentId: COMPONENT_ID,
      proposeFieldValue: async ({ currentValue }) => `${currentValue}!`,
    });

    if (!adapter.propose_new_texts) {
      throw new Error('propose_new_texts must be implemented');
    }
    const result = await adapter.propose_new_texts(
      {
        [COMPONENT_ID]: 'corrupted free-form text',
      },
      {},
      [
        COMPONENT_ID,
      ],
    );

    expect(parseFieldText(result[COMPONENT_ID])).toEqual({
      [INSTRUCTIONS_PATH]: 'original instructions!',
      'agent.tools.search.description': 'original tool description!',
    });
  });
});

//#endregion

//#region extractBestCandidate

describe('extractBestCandidate', () => {
  const fields = makeFields();
  const initialCandidate: Candidate = {
    [INSTRUCTIONS_PATH]: 'original instructions',
    'agent.tools.search.description': 'original tool description',
  };
  const fieldOrder = fields.map((f) => f.path);

  function pointWithText(text: string, score: number) {
    return {
      scores: {
        avg: score,
      },
      configuration: {
        candidate: 0,
        componentMap: {
          [COMPONENT_ID]: text,
        },
      },
    };
  }

  test('selects the point with the highest AVERAGE score, not paretoFront[0]', () => {
    const lowText = serializeFields(
      {
        ...initialCandidate,
        [INSTRUCTIONS_PATH]: 'low scoring variant',
      },
      fieldOrder,
    );
    const highText = serializeFields(
      {
        ...initialCandidate,
        [INSTRUCTIONS_PATH]: 'high scoring variant',
      },
      fieldOrder,
    );

    const { bestCandidate, bestScore } = extractBestCandidate({
      paretoFront: [
        pointWithText(lowText, 0.2),
        pointWithText(highText, 0.9),
      ],
      fields,
      initialCandidate,
      componentId: COMPONENT_ID,
    });

    expect(bestCandidate[INSTRUCTIONS_PATH]).toBe('high scoring variant');
    expect(bestScore).toBe(0.9);
  });

  test('reads configuration.instruction when componentMap is absent', () => {
    const text = serializeFields(
      {
        ...initialCandidate,
        [INSTRUCTIONS_PATH]: 'from instruction key',
      },
      fieldOrder,
    );
    const { bestCandidate } = extractBestCandidate({
      paretoFront: [
        {
          scores: {
            avg: 0.7,
          },
          configuration: {
            instruction: text,
          },
        },
      ],
      fields,
      initialCandidate,
      componentId: COMPONENT_ID,
    });

    expect(bestCandidate[INSTRUCTIONS_PATH]).toBe('from instruction key');
  });

  test('unparseable configuration text falls back to the initial candidate', () => {
    const { bestCandidate } = extractBestCandidate({
      paretoFront: [
        pointWithText('not marker text at all', 0.8),
      ],
      fields,
      initialCandidate,
      componentId: COMPONENT_ID,
    });

    expect(bestCandidate).toEqual(initialCandidate);
  });

  test('configuration missing both componentMap text and instruction falls back', () => {
    const { bestCandidate } = extractBestCandidate({
      paretoFront: [
        {
          scores: {
            avg: 0.6,
          },
          configuration: {
            candidate: 2,
          },
        },
      ],
      fields,
      initialCandidate,
      componentId: COMPONENT_ID,
    });

    expect(bestCandidate).toEqual(initialCandidate);
  });

  test('empty pareto front returns the initial candidate with score 0', () => {
    const { bestCandidate, bestScore, frontier } = extractBestCandidate({
      paretoFront: [],
      fields,
      initialCandidate,
      componentId: COMPONENT_ID,
    });

    expect(bestCandidate).toEqual(initialCandidate);
    expect(bestScore).toBe(0);
    expect(frontier).toEqual([]);
  });

  test('frontier maps every point (parseable or not)', () => {
    const goodText = serializeFields(
      {
        ...initialCandidate,
        [INSTRUCTIONS_PATH]: 'variant A',
      },
      fieldOrder,
    );
    const { frontier } = extractBestCandidate({
      paretoFront: [
        pointWithText(goodText, 0.4),
        pointWithText('garbage', 0.3),
      ],
      fields,
      initialCandidate,
      componentId: COMPONENT_ID,
    });

    expect(frontier).toHaveLength(2);
    expect(frontier[0][INSTRUCTIONS_PATH]).toBe('variant A');
    expect(frontier[1]).toEqual(initialCandidate);
  });
});

//#endregion
