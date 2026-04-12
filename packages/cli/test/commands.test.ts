/**
 * Tests for the slash command system.
 */

import { describe, expect, test } from 'bun:test';

import {
  BUILTIN_COMMANDS,
  commandsToPromptSuggestions,
  findCommand,
  generateCommandSuggestions,
  getEnabledCommands,
  getVisibleCommands,
  hasCommand,
  isSlashCommand,
  parseSlashCommand,
} from '../src/commands/index.js';

describe('parseSlashCommand', () => {
  test('returns null for non-slash input', () => {
    expect(parseSlashCommand('hello world')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
    expect(parseSlashCommand('  ')).toBeNull();
  });

  test('parses command without arguments', () => {
    const result = parseSlashCommand('/clear');
    expect(result).toEqual({
      commandName: 'clear',
      args: '',
    });
  });

  test('parses command with arguments', () => {
    const result = parseSlashCommand('/skills search');
    expect(result).toEqual({
      commandName: 'skills',
      args: 'search',
    });
  });

  test('trims whitespace', () => {
    const result = parseSlashCommand('  /clear  ');
    expect(result).toEqual({
      commandName: 'clear',
      args: '',
    });
  });

  test('handles multiple arguments', () => {
    const result = parseSlashCommand('/test arg1 arg2 arg3');
    expect(result).toEqual({
      commandName: 'test',
      args: 'arg1 arg2 arg3',
    });
  });
});

describe('isSlashCommand', () => {
  test('returns true for slash commands', () => {
    expect(isSlashCommand('/clear')).toBe(true);
    expect(isSlashCommand('  /skills')).toBe(true);
  });

  test('returns false for non-slash input', () => {
    expect(isSlashCommand('hello')).toBe(false);
    expect(isSlashCommand('')).toBe(false);
    expect(isSlashCommand('clear')).toBe(false);
  });
});

describe('findCommand', () => {
  test('finds command by name', () => {
    const cmd = findCommand('clear', BUILTIN_COMMANDS);
    expect(cmd).toBeDefined();
    expect(cmd?.name).toBe('clear');
  });

  test('finds command case-insensitively', () => {
    const cmd = findCommand('CLEAR', BUILTIN_COMMANDS);
    expect(cmd).toBeDefined();
    expect(cmd?.name).toBe('clear');
  });

  test('returns undefined for unknown command', () => {
    const cmd = findCommand('unknown', BUILTIN_COMMANDS);
    expect(cmd).toBeUndefined();
  });
});

describe('hasCommand', () => {
  test('returns true for existing command', () => {
    expect(hasCommand('clear', BUILTIN_COMMANDS)).toBe(true);
    expect(hasCommand('context', BUILTIN_COMMANDS)).toBe(true);
    expect(hasCommand('skills', BUILTIN_COMMANDS)).toBe(true);
  });

  test('returns false for non-existing command', () => {
    expect(hasCommand('unknown', BUILTIN_COMMANDS)).toBe(false);
  });
});

describe('BUILTIN_COMMANDS', () => {
  test('contains expected commands', () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name);
    expect(names).toContain('clear');
    expect(names).toContain('context');
    expect(names).toContain('skills');
  });

  test('all commands have descriptions', () => {
    for (const cmd of BUILTIN_COMMANDS) {
      expect(cmd.description).toBeTruthy();
    }
  });
});

describe('getEnabledCommands', () => {
  test('returns all commands when all enabled', () => {
    const enabled = getEnabledCommands(BUILTIN_COMMANDS);
    expect(enabled.length).toBe(BUILTIN_COMMANDS.length);
  });
});

describe('getVisibleCommands', () => {
  test('returns non-hidden enabled commands', () => {
    const visible = getVisibleCommands(BUILTIN_COMMANDS);
    expect(visible.length).toBe(BUILTIN_COMMANDS.length);
  });
});

describe('commandsToPromptSuggestions', () => {
  test('converts commands to prompt format', () => {
    const suggestions = commandsToPromptSuggestions(BUILTIN_COMMANDS);
    expect(suggestions.length).toBe(BUILTIN_COMMANDS.length);

    for (const sug of suggestions) {
      expect(sug.cmd).toMatch(/^\//);
      expect(sug.desc).toBeTruthy();
    }
  });
});

describe('generateCommandSuggestions', () => {
  test('returns empty for non-slash input', () => {
    const suggestions = generateCommandSuggestions('hello', BUILTIN_COMMANDS);
    expect(suggestions).toEqual([]);
  });

  test('returns all commands for just slash', () => {
    const suggestions = generateCommandSuggestions('/', BUILTIN_COMMANDS);
    expect(suggestions.length).toBe(BUILTIN_COMMANDS.length);
  });

  test('filters by prefix', () => {
    const suggestions = generateCommandSuggestions('/cl', BUILTIN_COMMANDS);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]?.command.name).toBe('clear');
  });

  test('ranks exact matches first', () => {
    const suggestions = generateCommandSuggestions('/clear', BUILTIN_COMMANDS);
    expect(suggestions[0]?.command.name).toBe('clear');
  });
});
