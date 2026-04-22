/**
 * Prompt-input parsing.
 *
 * Routes:
 *   `/foo ...`          -> slash command
 *   `! <cmd>`           -> local bash command (explicit)
 *   `<known> [args]`    -> local bash command (auto-detected from a fixed set)
 *   anything else       -> regular agent message
 */

//#region Types

interface ParsedSlashCommand {
  /** Command name (without leading slash) */
  commandName: string;
  /** Arguments after the command name */
  args: string;
}

//#endregion

//#region Auto-detect set

/**
 * First-token allowlist for bare-command auto-detection.
 * Kept small to avoid colliding with natural-language prompts.
 */
const AUTO_DETECT_COMMANDS: ReadonlySet<string> = new Set([
  'git',
  'cd',
  'mv',
  'cp',
  'ls',
  'rm',
  'pwd',
  'cat',
  'grep',
  'find',
  'which',
  'echo',
]);

const FIRST_TOKEN_RE = /^([A-Za-z][\w.-]*)(?=$|\s)/;

//#endregion

//#region Slash parser

/**
 * Parse user input as a slash command.
 * Returns null if input doesn't start with '/'.
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const withoutSlash = trimmed.slice(1);
  const spaceIndex = withoutSlash.search(/\s/);

  if (spaceIndex === -1) {
    return {
      commandName: withoutSlash,
      args: '',
    };
  }

  return {
    commandName: withoutSlash.slice(0, spaceIndex),
    args: withoutSlash.slice(spaceIndex + 1).trim(),
  };
}

/**
 * Check if input looks like a slash command.
 */
export function isSlashCommand(input: string): boolean {
  return input.trim().startsWith('/');
}

//#endregion

//#region Bash parser

/**
 * True if the first token of `input` is in the auto-detect allowlist,
 * followed by whitespace or end-of-input (so `lsof`, `github`, `cats`
 * don't match).
 */
export function isAutoDetectedShellCommand(input: string): boolean {
  const trimmed = input.trimStart();
  const match = FIRST_TOKEN_RE.exec(trimmed);
  if (!match) {
    return false;
  }
  return AUTO_DETECT_COMMANDS.has(match[1]);
}

/**
 * True if `input` should be routed to the local bash path.
 * Matches either an explicit `!` prefix with a non-empty command,
 * or an auto-detected bare command.
 */
export function isBashCommand(input: string): boolean {
  const trimmed = input.trimStart();
  if (trimmed.startsWith('!')) {
    return trimmed.slice(1).trim().length > 0;
  }
  return isAutoDetectedShellCommand(trimmed);
}

/**
 * Parse user input as a local bash command. Returns null for anything else.
 * `!` alone (or `!` + whitespace) is NOT a bash command — pass it to the agent.
 */
export function parseBashCommand(input: string): string | null {
  const trimmed = input.trimStart();

  if (trimmed.startsWith('!')) {
    const command = trimmed.slice(1).trim();
    return command.length === 0 ? null : command;
  }

  if (isAutoDetectedShellCommand(trimmed)) {
    return trimmed.trimEnd();
  }

  return null;
}

//#endregion

export type { ParsedSlashCommand };
