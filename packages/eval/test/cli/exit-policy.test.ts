import { describe, expect, test } from 'bun:test';

import type { RunOutcome } from '../../src/cli/exit-policy';
import { computeExitCode, ExitCode } from '../../src/cli/exit-policy';

function outcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    unresolvedPatterns: [],
    failedCases: 0,
    ...overrides,
  };
}

describe('computeExitCode', () => {
  test('all passed -> 0', () => {
    expect(computeExitCode(outcome())).toBe(ExitCode.Success);
  });

  test('empty discovery (no failures, no patterns) -> 0', () => {
    expect(
      computeExitCode(
        outcome({
          failedCases: 0,
        }),
      ),
    ).toBe(ExitCode.Success);
  });

  test('failed case boundary: 0 -> success, 1 -> failure, 2 -> failure', () => {
    expect(
      computeExitCode(
        outcome({
          failedCases: 0,
        }),
      ),
    ).toBe(ExitCode.Success);
    expect(
      computeExitCode(
        outcome({
          failedCases: 1,
        }),
      ),
    ).toBe(ExitCode.Failure);
    expect(
      computeExitCode(
        outcome({
          failedCases: 2,
        }),
      ),
    ).toBe(ExitCode.Failure);
  });

  test('unresolvable explicit pattern -> 1 even when all cases passed', () => {
    expect(
      computeExitCode(
        outcome({
          unresolvedPatterns: [
            'no-such-eval',
          ],
        }),
      ),
    ).toBe(ExitCode.Failure);
  });

  test('--check clean -> 0', () => {
    expect(
      computeExitCode(
        outcome({
          regressionCheck: {
            regressed: false,
            missingCount: 0,
          },
        }),
      ),
    ).toBe(ExitCode.Success);
  });

  test('--check regression -> 1', () => {
    expect(
      computeExitCode(
        outcome({
          regressionCheck: {
            regressed: true,
            missingCount: 0,
          },
        }),
      ),
    ).toBe(ExitCode.Failure);
  });

  test('--check missing baseline case boundary: 0 -> success, 1 -> failure', () => {
    expect(
      computeExitCode(
        outcome({
          regressionCheck: {
            regressed: false,
            missingCount: 0,
          },
        }),
      ),
    ).toBe(ExitCode.Success);
    expect(
      computeExitCode(
        outcome({
          regressionCheck: {
            regressed: false,
            missingCount: 1,
          },
        }),
      ),
    ).toBe(ExitCode.Failure);
    expect(
      computeExitCode(
        outcome({
          regressionCheck: {
            regressed: false,
            missingCount: 2,
          },
        }),
      ),
    ).toBe(ExitCode.Failure);
  });

  test('failures combine: failed case + clean check still -> 1', () => {
    expect(
      computeExitCode(
        outcome({
          failedCases: 1,
          regressionCheck: {
            regressed: false,
            missingCount: 0,
          },
        }),
      ),
    ).toBe(ExitCode.Failure);
  });

  test('exit code constants are stable', () => {
    expect(ExitCode.Success).toBe(0);
    expect(ExitCode.Failure).toBe(1);
    expect(ExitCode.Usage).toBe(2);
  });
});
