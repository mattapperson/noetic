/**
 * Shutdown helpers: closing several things must try every one of them, so one
 * that throws never leaves the rest open.
 */

//#region Public API

/**
 * Runs every task in order, carrying on past one that throws, then rethrows
 * the first failure once all have run.
 */
export async function runEvery(
  tasks: ReadonlyArray<() => Promise<unknown> | unknown>,
): Promise<void> {
  let failure:
    | {
        readonly error: unknown;
      }
    | undefined;
  for (const task of tasks) {
    try {
      await task();
    } catch (error) {
      failure ??= {
        error,
      };
    }
  }
  if (failure) {
    throw failure.error;
  }
}

//#endregion
