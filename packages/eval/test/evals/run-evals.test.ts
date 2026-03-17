import { describe, expect, test } from 'bun:test';

import { clearSuites, getSuites, runAllSuites } from '../../src';

//#region Constants

const HAS_API_KEY = Boolean(process.env.OPENROUTER_API_KEY);
const ONLINE_TIMEOUT = 12e4; // 2 minutes per eval

//#endregion

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

//#region Online Eval Suite Tests

describe('online eval suites', () => {
  test.skipIf(!HAS_API_KEY)(
    'support-agent eval',
    async () => {
      await runEvalFile('../../evals/support-agent.eval');
    },
    ONLINE_TIMEOUT,
  );

  test.skipIf(!HAS_API_KEY)(
    'routing-agent eval',
    async () => {
      await runEvalFile('../../evals/routing-agent.eval');
    },
    ONLINE_TIMEOUT,
  );

  test.skipIf(!HAS_API_KEY)(
    'code-writer eval',
    async () => {
      await runEvalFile('../../evals/code-writer.eval');
    },
    ONLINE_TIMEOUT,
  );
});

//#endregion
