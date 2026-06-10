//#region Types

/** Result of a `--check` regression comparison, aggregated across suites. */
export interface RegressionCheckOutcome {
  /** Any case regressed beyond the threshold. */
  regressed: boolean;
  /** Baseline cases absent from the current run. */
  missingCount: number;
}

/** Everything `computeExitCode` needs to decide the process exit code. */
export interface RunOutcome {
  /** Explicit file patterns that resolved to no eval file. */
  unresolvedPatterns: string[];
  /** Cases with `passed === false` (thrown case errors included). */
  failedCases: number;
  /** Present only when `--check` ran against at least one baseline. */
  regressionCheck?: RegressionCheckOutcome;
}

//#endregion

//#region Constants

export const ExitCode = {
  /** All cases passed; under --check, no regressions and no missing cases. */
  Success: 0,
  /** Eval failure: failed/errored case, regression, missing baseline case, unresolvable pattern, infra error. */
  Failure: 1,
  /** Usage error (unknown flag, invalid flag value). */
  Usage: 2,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

//#endregion

//#region Public API

/**
 * Map a run outcome to an exit code.
 *
 * - `0` — every case passed (empty discovery with no explicit patterns is OK;
 *   `--check` with no saved baseline is OK)
 * - `1` — any failed/errored case, a `--check` regression or missing baseline
 *   case, or an explicit file pattern that resolved to nothing
 *
 * Usage errors (exit `2`) are thrown as `UsageError` before a run starts and
 * never reach this function. Watch mode never propagates child failures.
 */
export function computeExitCode(outcome: RunOutcome): ExitCodeValue {
  if (outcome.unresolvedPatterns.length > 0) {
    return ExitCode.Failure;
  }
  if (outcome.failedCases > 0) {
    return ExitCode.Failure;
  }
  if (outcome.regressionCheck) {
    if (outcome.regressionCheck.regressed || outcome.regressionCheck.missingCount > 0) {
      return ExitCode.Failure;
    }
  }
  return ExitCode.Success;
}

//#endregion
