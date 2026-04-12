/**
 * Command registry and discovery.
 *
 * Provides lookup utilities for commands.
 */

import type { Command } from './types.js';

//#region Lookup Utilities

/**
 * Find a command by name or alias.
 */
export function findCommand(name: string, commands: ReadonlyArray<Command>): Command | undefined {
  const lowerName = name.toLowerCase();
  for (const cmd of commands) {
    if (cmd.name.toLowerCase() === lowerName) {
      return cmd;
    }
    if (cmd.aliases?.some((a) => a.toLowerCase() === lowerName)) {
      return cmd;
    }
  }
  return undefined;
}

/**
 * Check if a command exists by name or alias.
 */
export function hasCommand(name: string, commands: ReadonlyArray<Command>): boolean {
  return findCommand(name, commands) !== undefined;
}

/**
 * Get enabled commands only.
 */
export function getEnabledCommands(commands: ReadonlyArray<Command>): Command[] {
  return commands.filter((cmd) => cmd.isEnabled?.() ?? true);
}

/**
 * Get commands visible in help/autocomplete (enabled and not hidden).
 */
export function getVisibleCommands(commands: ReadonlyArray<Command>): Command[] {
  return commands.filter((cmd) => {
    const isEnabled = cmd.isEnabled?.() ?? true;
    const isHidden = cmd.isHidden ?? false;
    return isEnabled && !isHidden;
  });
}

//#endregion
