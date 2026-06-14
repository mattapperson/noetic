/**
 * Helpers for declaring the cross-harness built-in tool vocabulary.
 */

import type { SubHarnessBuiltinTool } from '@noetic-tools/types';

/**
 * Declare a built-in tool the underlying agent executes natively, mapping its
 * native name to a shared `commonName` so consumers can recognise the same
 * kind of tool across harnesses (Claude's `Bash`, Codex's `shell`, pi's
 * `bash` → `shell`).
 * @public
 */
export function commonTool(
  nativeName: string,
  commonName?: string,
  description?: string,
): SubHarnessBuiltinTool {
  return {
    nativeName,
    commonName,
    description,
  };
}
