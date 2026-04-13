/**
 * Command suggestion generation for autocomplete.
 *
 * Provides fuzzy matching and ranking for slash command suggestions,
 * inspired by Claude Code's command suggestion system.
 */

import type { Command } from './types.js';

//#region Types

interface CommandSuggestion {
  /** Display text (e.g. "/clear") */
  text: string;
  /** Description shown after the command */
  desc?: string;
  /** The underlying command object */
  command: Command;
  /** Match score (lower is better) */
  score: number;
}

//#endregion

//#region Matching Helpers

/**
 * Calculate a simple match score for a command against a query.
 * Lower score = better match.
 */
function getMatchScore(commandName: string, query: string): number {
  const lowerName = commandName.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // Exact match
  if (lowerName === lowerQuery) {
    return 0;
  }

  // Prefix match
  if (lowerName.startsWith(lowerQuery)) {
    // Shorter names rank higher for prefix matches
    return 1 + lowerName.length / 100;
  }

  // Contains match
  if (lowerName.includes(lowerQuery)) {
    return 2 + lowerName.indexOf(lowerQuery) / 100;
  }

  // No match
  return Number.POSITIVE_INFINITY;
}

/**
 * Check if a command matches a query (by name or alias).
 */
function commandMatches(cmd: Command, query: string): boolean {
  if (query === '') {
    return true;
  }

  const lowerQuery = query.toLowerCase();

  // Check main name
  if (cmd.name.toLowerCase().includes(lowerQuery)) {
    return true;
  }

  // Check aliases
  if (cmd.aliases?.some((a) => a.toLowerCase().includes(lowerQuery))) {
    return true;
  }

  return false;
}

//#endregion

//#region Public API

/**
 * Generate command suggestions based on input.
 *
 * @param input - User input (should start with '/')
 * @param commands - Available commands
 * @returns Sorted suggestions, best match first
 */
export function generateCommandSuggestions(
  input: string,
  commands: ReadonlyArray<Command>,
): CommandSuggestion[] {
  // Only process command input
  if (!input.startsWith('/')) {
    return [];
  }

  const query = input.slice(1).trim();

  // Filter and score commands
  const suggestions: CommandSuggestion[] = [];

  for (const cmd of commands) {
    // Skip hidden or disabled commands
    if (cmd.isHidden) {
      continue;
    }
    if (cmd.isEnabled && !cmd.isEnabled()) {
      continue;
    }

    if (!commandMatches(cmd, query)) {
      continue;
    }

    // Calculate score (best match on name or alias)
    let score = getMatchScore(cmd.name, query);

    // Check aliases for better match
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        const aliasScore = getMatchScore(alias, query);
        if (aliasScore < score) {
          score = aliasScore;
        }
      }
    }

    suggestions.push({
      text: `/${cmd.name}`,
      desc: cmd.description,
      command: cmd,
      score,
    });
  }

  // Sort by score (lower is better), then alphabetically
  suggestions.sort((a, b) => {
    if (a.score !== b.score) {
      return a.score - b.score;
    }
    return a.command.name.localeCompare(b.command.name);
  });

  return suggestions;
}

/**
 * Convert commands to the simple format expected by PromptInput.
 */
export function commandsToPromptSuggestions(commands: ReadonlyArray<Command>): Array<{
  cmd: string;
  desc?: string;
}> {
  return commands
    .filter((cmd) => {
      if (cmd.isHidden) {
        return false;
      }
      if (cmd.isEnabled && !cmd.isEnabled()) {
        return false;
      }
      return true;
    })
    .map((cmd) => ({
      cmd: `/${cmd.name}`,
      desc: cmd.description,
    }));
}

//#endregion
