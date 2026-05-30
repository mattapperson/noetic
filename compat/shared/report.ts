/**
 * Pure result-formatting helpers shared by every runtime entry. No environment
 * or runtime-specific access here so the module imports everywhere.
 */

import type { Runtime, SmokeResult } from './types.js';

/** Render a successful smoke result as a compact human summary. */
export function formatSuccess(result: SmokeResult): string {
  const codeAgentLine = result.codeAgent
    ? `  code-agent: reply="${result.codeAgent.reply}" tools=${result.codeAgent.toolCount} fs="${result.codeAgent.fileRoundTrip}"`
    : `  code-agent: skipped (${result.codeAgentSkipReason})`;
  const lines = [
    `✓ [${result.runtime}] smoke passed in ${result.durationMs}ms (model: ${result.model})`,
    `  core:       reply="${result.core.reply}" tokens=${result.core.inputTokens}/${result.core.outputTokens}`,
    codeAgentLine,
  ];
  return lines.join('\n');
}

/** Render a failure as a single labelled line. */
export function formatFailure(runtime: Runtime, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `✗ [${runtime}] smoke failed: ${message}`;
}
