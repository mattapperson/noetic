import { afterEach, describe, expect, test } from 'bun:test';
import { callModel } from '@noetic-tools/core';

import { optimize } from '../../src/optimization/optimizer';
import { OptimizeScope } from '../../src/types/eval';
import type { OptimizableField } from '../../src/types/optimizer';
import { FieldKind } from '../../src/types/optimizer';

const step = callModel({
  id: 'agent',
  model: 'openai/gpt-4o-mini',
  instructions: 'original instructions',
});

const fields: OptimizableField[] = [
  {
    path: 'agent.instructions',
    value: 'original instructions',
    stepId: 'agent',
    fieldKind: FieldKind.Instructions,
  },
];

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.NOETIC_API_KEY;
});

describe('optimizer GEPA seam regression', () => {
  test('loadGepaBridge stubs optimize without poisoning the real gepa-bridge module', async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.NOETIC_API_KEY;

    const mocked = await optimize({
      step,
      scope: OptimizeScope.PromptsOnly,
      preEnrichedFields: fields,
      runEval: async () => ({
        accuracy: 1,
      }),
      loadGepaBridge: async () => ({
        optimizeWithGepa: async () => ({
          bestCandidate: {
            'agent.instructions': 'mocked instructions',
          },
          score: 1,
          iterations: 1,
        }),
      }),
    });

    expect(mocked.bestCandidate['agent.instructions']).toBe('mocked instructions');

    const bridge = await import('../../src/optimization/gepa-bridge');
    let evaluated = 0;
    const real = await bridge.optimizeWithGepa({
      step,
      fields,
      runEval: async () => {
        evaluated++;
        return {
          accuracy: 1,
        };
      },
    });

    expect(evaluated).toBe(1);
    expect(real.bestCandidate['agent.instructions']).toBe('original instructions');
    expect(real.iterations).toBe(1);
  });
});
