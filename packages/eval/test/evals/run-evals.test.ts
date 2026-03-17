import { describe, expect, test } from 'bun:test';

import { clearSuites, getSuites, runAllSuites } from '../../src';

//#region Helper Functions

async function runEvalFile(path: string): Promise<void> {
  clearSuites();
  await import(path);
  const suites = getSuites();
  expect(suites.length).toBeGreaterThan(0);
  const results = await runAllSuites(suites);
  for (const result of results) {
    for (const c of result.cases) {
      if (!c.passed) {
        throw new Error(`Case "${c.name}" failed: ${c.error}`);
      }
    }
  }
}

//#endregion

//#region Eval Suite Tests

describe('eval suites', () => {
  test('branching eval', async () => {
    await runEvalFile('../../evals/branching.eval');
  });

  test('plans eval', async () => {
    await runEvalFile('../../evals/plans.eval');
  });

  test('parallel eval', async () => {
    await runEvalFile('../../evals/parallel.eval');
  });

  test('eval-framework eval', async () => {
    await runEvalFile('../../evals/eval-framework.eval');
  });

  test('react-agent eval', async () => {
    await runEvalFile('../../evals/react-agent.eval');
  });

  test('ralph-wiggum eval', async () => {
    await runEvalFile('../../evals/ralph-wiggum.eval');
  });
});

//#endregion
