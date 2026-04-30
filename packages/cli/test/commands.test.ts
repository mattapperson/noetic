/**
 * Tests for the slash command system.
 */

import { describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';

import { AGENT_READINESS_PROMPT } from '../src/commands/builtins/agent-readiness.js';
import {
  BUILTIN_COMMANDS,
  commandsToPromptSuggestions,
  findCommand,
  generateCommandSuggestions,
  getEnabledCommands,
  getVisibleCommands,
  hasCommand,
  isAutoDetectedShellCommand,
  isBashCommand,
  isSlashCommand,
  parseBashCommand,
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
    expect(names).toContain('agent-readiness');
    expect(names).toContain('diff-review');
    expect(names).toContain('tasks');
  });

  test('all commands have descriptions', () => {
    for (const cmd of BUILTIN_COMMANDS) {
      expect(cmd.description).toBeTruthy();
    }
  });
});

describe('/diff-review command', () => {
  test('is registered as a local-jsx command', () => {
    const cmd = findCommand('diff-review', BUILTIN_COMMANDS);
    assert(cmd !== undefined);
    expect(cmd.type).toBe('local-jsx');
    expect(cmd.description).toBeTruthy();
  });
});

describe('/tasks command', () => {
  test('is registered as a local command', () => {
    const cmd = findCommand('tasks', BUILTIN_COMMANDS);
    assert(cmd !== undefined);
    expect(cmd.type).toBe('local');
    expect(cmd.description).toBeTruthy();
  });
});

describe('/agent-readiness command', () => {
  test('is registered as a local command', () => {
    const cmd = findCommand('agent-readiness', BUILTIN_COMMANDS);
    assert(cmd !== undefined);
    expect(cmd.type).toBe('local');
    expect(cmd.description).toBeTruthy();
  });

  test('prompt starts with expected opener and is substantive', () => {
    expect(AGENT_READINESS_PROMPT.startsWith('Set up a minimal CLAUDE.md')).toBe(true);
    expect(AGENT_READINESS_PROMPT.length).toBeGreaterThan(1e3);
    expect(AGENT_READINESS_PROMPT).toContain('## Phase 1: Ask what to set up');
    expect(AGENT_READINESS_PROMPT).toContain('## Phase 8: Summary and next steps');
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

describe('isBashCommand', () => {
  test('returns true for bang prefix with command', () => {
    expect(isBashCommand('!ls')).toBe(true);
    expect(isBashCommand('! ls')).toBe(true);
    expect(isBashCommand('  !ls -la')).toBe(true);
    expect(isBashCommand('!/foo')).toBe(true);
  });

  test('returns false for bare bang or bang + whitespace', () => {
    expect(isBashCommand('!')).toBe(false);
    expect(isBashCommand('! ')).toBe(false);
    expect(isBashCommand('!   ')).toBe(false);
  });

  test('returns true for auto-detected commands', () => {
    expect(isBashCommand('git status')).toBe(true);
    expect(isBashCommand('ls')).toBe(true);
    expect(isBashCommand('cd foo')).toBe(true);
    expect(isBashCommand('pwd')).toBe(true);
    expect(isBashCommand('grep -r "x" .')).toBe(true);
    expect(isBashCommand('echo hi')).toBe(true);
  });

  test('returns false for natural language with similar prefixes', () => {
    expect(isBashCommand('lsof')).toBe(false);
    expect(isBashCommand('cats are great')).toBe(false);
    expect(isBashCommand('github')).toBe(false);
    expect(isBashCommand('let x = 1')).toBe(false);
    expect(isBashCommand('hello world')).toBe(false);
    expect(isBashCommand('')).toBe(false);
  });
});

describe('isAutoDetectedShellCommand', () => {
  test('matches only exact first-token hits', () => {
    expect(isAutoDetectedShellCommand('git status')).toBe(true);
    expect(isAutoDetectedShellCommand('git')).toBe(true);
    expect(isAutoDetectedShellCommand('github')).toBe(false);
    expect(isAutoDetectedShellCommand('gitstatus')).toBe(false);
  });

  test('false for empty/whitespace input', () => {
    expect(isAutoDetectedShellCommand('')).toBe(false);
    expect(isAutoDetectedShellCommand('   ')).toBe(false);
  });
});

describe('parseBashCommand', () => {
  test('strips bang prefix', () => {
    expect(parseBashCommand('!ls')).toBe('ls');
    expect(parseBashCommand('! ls -la')).toBe('ls -la');
    expect(parseBashCommand('  !echo hi  ')).toBe('echo hi');
  });

  test('returns null for bare bang', () => {
    expect(parseBashCommand('!')).toBeNull();
    expect(parseBashCommand('!   ')).toBeNull();
  });

  test('returns the command for allowlist tokens', () => {
    expect(parseBashCommand('git status')).toBe('git status');
    expect(parseBashCommand('ls')).toBe('ls');
  });

  test('returns null for non-matching input', () => {
    expect(parseBashCommand('hello world')).toBeNull();
    expect(parseBashCommand('lsof -i')).toBeNull();
    expect(parseBashCommand('')).toBeNull();
  });

  test('preserves inner whitespace but trims ends', () => {
    expect(parseBashCommand('   ls   foo   bar   ')).toBe('ls   foo   bar');
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
