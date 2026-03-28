import { describe as bunDescribe, expect, test } from 'bun:test';
import { AgentHarness, step } from '@noetic/core';
import { describe } from '../../src/runner/describe';
import type { EvalContext } from '../../src/runner/eval-context';
import { it } from '../../src/runner/it';
import { clearSuites, getSuites } from '../../src/runner/registry';

bunDescribe('it.each()', () => {
  test('registers one case per dataset item with inline array', () => {
    clearSuites();

    const testStep = step.run({
      id: 'echo',
      execute: async (input: unknown) => input,
    });

    const dataset = [
      {
        input: 'hello',
        expected: 'hello',
      },
      {
        input: 'world',
        expected: 'world',
      },
    ];

    describe(testStep, {
      objective: 'dataset test',
    }, () => {
      it.each(dataset, async (ctx) => {
        const result = await ctx.execute(ctx.example.input);
        expect(result.output).toBe(ctx.example.expected);
      });
    });

    const suites = getSuites();
    expect(suites).toHaveLength(1);
    expect(suites[0].cases).toHaveLength(2);
    expect(suites[0].cases[0].name).toBe('[dataset 0]');
    expect(suites[0].cases[1].name).toBe('[dataset 1]');
  });

  test('dataset items are passed correctly to the fn', async () => {
    clearSuites();

    const testStep = step.run({
      id: 'echo',
      execute: async (input: unknown) => input,
    });

    const captured: string[] = [];

    describe(testStep, {
      objective: 'capture test',
    }, () => {
      it.each(
        [
          {
            value: 'alpha',
          },
          {
            value: 'beta',
          },
        ],
        async (ctx) => {
          captured.push(ctx.example.value);
        },
      );
    });

    const suites = getSuites();
    const suite = suites[0];

    // Execute each case fn with a mock EvalContext
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const mockCtx: EvalContext = {
      objective: 'capture test',
      background: '',
      execute: async () => ({
        output: null,
        context: harness.createContext(),
        traces: [],
        score: async () => [],
      }),
    };

    for (const caseDef of suite.cases) {
      await caseDef.fn(mockCtx);
    }

    expect(captured).toEqual([
      'alpha',
      'beta',
    ]);
  });
});
