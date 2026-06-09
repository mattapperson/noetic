/**
 * Pure helpers that compose the final `AgentRuntimeConfig` fields from the
 * layered inputs (CLI args, discovered config file, resumed session). Kept
 * separate from `cli.ts` so they can be unit-tested without booting the TUI.
 */

export interface ComposeRuntimeModelInput {
  /** Whatever `parseArgs` produced — may be the DEFAULT_MODEL or user-provided. */
  cliModel: string;
  /** `true` only when the user actually passed `--model` on the command line. */
  modelExplicit: boolean;
  /** The `model` field from the resumed session, if any. */
  sessionModel?: string;
  /** The `model` field from a discovered `noetic.config.ts`, if any. */
  configFileModel?: string;
}

/**
 * Resolve the model precedence:
 *   1. CLI `--model` (when explicitly passed)
 *   2. Resumed session's saved model
 *   3. `noetic.config.ts` model
 *   4. The CLI fallback (which is the baked-in `DEFAULT_MODEL`)
 */
export function composeRuntimeModel(input: ComposeRuntimeModelInput): string {
  if (input.modelExplicit) {
    return input.cliModel;
  }
  if (input.sessionModel !== undefined && input.sessionModel.length > 0) {
    return input.sessionModel;
  }
  if (input.configFileModel !== undefined && input.configFileModel.length > 0) {
    return input.configFileModel;
  }
  return input.cliModel;
}
