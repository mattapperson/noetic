import { describe, expect, it } from 'bun:test';

import {
  INTERACTIVE_TUI_COMMANDS,
  isBannedCommand,
  isInteractiveCommand,
  validateCommand,
} from '../src/tools/security.js';

describe('isInteractiveCommand', () => {
  it('returns the matched name for vim, nano, less, top', () => {
    expect(isInteractiveCommand('vim foo.txt')).toBe('vim');
    expect(isInteractiveCommand('nano /etc/hosts')).toBe('nano');
    expect(isInteractiveCommand('less file')).toBe('less');
    expect(isInteractiveCommand('top')).toBe('top');
  });

  it('returns the command name on match', () => {
    expect(isInteractiveCommand('htop -d 1')).toBe('htop');
  });

  it('returns undefined for non-TUI commands', () => {
    expect(isInteractiveCommand('ls -la')).toBeUndefined();
    expect(isInteractiveCommand('git log --oneline')).toBeUndefined();
    expect(isInteractiveCommand('cat foo')).toBeUndefined();
    expect(isInteractiveCommand('python script.py')).toBeUndefined();
  });

  it('only matches the first token (does not scan pipelines)', () => {
    // Pipelines are caught by runtime alt-screen detection; first-token match
    // keeps the static check predictable and avoids false positives like
    // file paths containing `vim`.
    expect(isInteractiveCommand('cat foo | less')).toBeUndefined();
    expect(isInteractiveCommand('cat /tmp/vim-config')).toBeUndefined();
  });
});

describe('validateCommand interactive rejection', () => {
  it('rejects vim with a guidance message', () => {
    const result = validateCommand('vim foo.txt');
    expect(result.valid).toBe(false);
    expect(result.error).toContain("'vim'");
    expect(result.error).toContain('interactive');
    expect(result.error).toContain('Read');
    expect(result.error).toContain('Edit');
  });

  it('rejects every entry in INTERACTIVE_TUI_COMMANDS', () => {
    for (const name of INTERACTIVE_TUI_COMMANDS) {
      const result = validateCommand(name);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(`'${name}'`);
    }
  });

  it('still rejects banned commands ahead of the interactive check', () => {
    const result = validateCommand('sudo rm /etc/foo');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('sudo');
  });

  it('passes safe non-interactive commands', () => {
    expect(validateCommand('ls -la').valid).toBe(true);
    expect(validateCommand('git status').valid).toBe(true);
  });
});

describe('regression: banned commands still work', () => {
  it('flags sudo as banned', () => {
    expect(isBannedCommand('sudo ls').banned).toBe(true);
  });
});
