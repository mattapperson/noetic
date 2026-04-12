/**
 * Slash command parsing.
 */

//#region Types

interface ParsedSlashCommand {
  /** Command name (without leading slash) */
  commandName: string;
  /** Arguments after the command name */
  args: string;
}

//#endregion

//#region Parser

/**
 * Parse user input as a slash command.
 * Returns null if input doesn't start with '/'.
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  // Remove leading slash and split on first whitespace
  const withoutSlash = trimmed.slice(1);
  const spaceIndex = withoutSlash.search(/\s/);

  if (spaceIndex === -1) {
    // No arguments
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

export type { ParsedSlashCommand };
