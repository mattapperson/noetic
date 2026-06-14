/**
 * A registry of sub-harness adapters keyed by their `harnessId`. Pass one to a
 * JSON workflow's `HydrationContext.subHarnesses` so `claude-code`/`codex`/…
 * nodes resolve to live adapters.
 */

import type { SubHarness, SubHarnessKind } from '@noetic-tools/types';

/** @public Sub-harness adapters keyed by harness id. */
export type SubHarnessRegistry = Map<SubHarnessKind, SubHarness>;

/** @public Build a {@link SubHarnessRegistry} from a list of adapters. */
export function createSubHarnessRegistry(...harnesses: SubHarness[]): SubHarnessRegistry {
  const registry: SubHarnessRegistry = new Map();
  for (const harness of harnesses) {
    registry.set(harness.harnessId, harness);
  }
  return registry;
}
