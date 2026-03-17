import { describe as bunDescribe, expect, test } from 'bun:test';
import { step } from '@noetic/core';
import { describe } from '../../src/runner/describe';
import { it } from '../../src/runner/it';
import { clearSuites, getSuites } from '../../src/runner/registry';

bunDescribe('describe()', () => {
  test('registers a suite in the registry', () => {
    clearSuites();

    const testStep = step.run({
      id: 'test-step',
      execute: async (input: unknown) => input,
    });

    describe({
      step: testStep,
    }, {
      objective: 'test objective',
    }, () => {});

    const suites = getSuites();
    expect(suites).toHaveLength(1);
    expect(suites[0].objective.objective).toBe('test objective');
    expect(suites[0].cases).toHaveLength(0);
  });

  test('captures it() cases within describe()', () => {
    clearSuites();

    const testStep = step.run({
      id: 'test-step',
      execute: async (input: unknown) => input,
    });

    describe({
      step: testStep,
    }, {
      objective: 'captures cases',
    }, () => {
      it('case one', async () => {});
      it('case two', async () => {});
    });

    const suites = getSuites();
    expect(suites).toHaveLength(1);
    expect(suites[0].cases).toHaveLength(2);
    expect(suites[0].cases[0].name).toBe('case one');
    expect(suites[0].cases[1].name).toBe('case two');
  });

  test('it() outside describe() throws', () => {
    expect(() => {
      it('orphan case', async () => {});
    }).toThrow('it() must be called inside describe()');
  });

  test('clearSuites() empties the registry', () => {
    clearSuites();

    const testStep = step.run({
      id: 'test-step',
      execute: async (input: unknown) => input,
    });

    describe({
      step: testStep,
    }, {
      objective: 'will be cleared',
    }, () => {});

    expect(getSuites()).toHaveLength(1);
    clearSuites();
    expect(getSuites()).toHaveLength(0);
  });
});
