import { runEvery } from '../connections/settle';
import { acpSessionsOf } from '../runtime/acp-session-store';
import { heldCallsOf } from '../runtime/held-calls';

/** Stop external work in every scope, even when one close fails. */
export async function closeHarness(
  harness: Parameters<typeof heldCallsOf>[0],
  cleanup: ReadonlyArray<() => Promise<void>>,
): Promise<void> {
  heldCallsOf(harness).releaseWatches();
  await runEvery([
    ...cleanup,
    () => acpSessionsOf(harness).closeAll(),
  ]);
}

/** The run owns its ACP sessions until its outermost step returns. */
export function closeRunAgents(
  harness: Parameters<typeof acpSessionsOf>[0],
  executionId: string,
): Promise<void> {
  return acpSessionsOf(harness).closeOwnedBy(executionId);
}
