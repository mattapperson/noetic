import { describe, expect, test } from 'bun:test';

import { detectNerdFonts } from '../src/nerd-fonts.js';

describe('detectNerdFonts', () => {
  test('mode "on" always returns true', () => {
    expect(detectNerdFonts('on', {})).toBe(true);
    expect(
      detectNerdFonts('on', {
        TERM_PROGRAM: 'unknown',
      }),
    ).toBe(true);
  });

  test('mode "off" always returns false', () => {
    expect(detectNerdFonts('off', {})).toBe(false);
    expect(
      detectNerdFonts('off', {
        TERM_PROGRAM: 'iTerm.app',
      }),
    ).toBe(false);
  });

  test('POWERLINE_NERD_FONTS=1 overrides auto detection', () => {
    expect(
      detectNerdFonts('auto', {
        POWERLINE_NERD_FONTS: '1',
      }),
    ).toBe(true);
    expect(
      detectNerdFonts('auto', {
        POWERLINE_NERD_FONTS: 'true',
      }),
    ).toBe(true);
  });

  test('POWERLINE_NERD_FONTS=0 overrides auto detection', () => {
    expect(
      detectNerdFonts('auto', {
        POWERLINE_NERD_FONTS: '0',
        TERM_PROGRAM: 'iTerm.app',
      }),
    ).toBe(false);
    expect(
      detectNerdFonts('auto', {
        POWERLINE_NERD_FONTS: 'false',
      }),
    ).toBe(false);
  });

  test('auto detects known nerd-capable terminals', () => {
    expect(
      detectNerdFonts('auto', {
        TERM_PROGRAM: 'iTerm.app',
      }),
    ).toBe(true);
    expect(
      detectNerdFonts('auto', {
        TERM_PROGRAM: 'WezTerm',
      }),
    ).toBe(true);
    expect(
      detectNerdFonts('auto', {
        TERM_PROGRAM: 'ghostty',
      }),
    ).toBe(true);
    expect(
      detectNerdFonts('auto', {
        TERM_PROGRAM: 'kitty',
      }),
    ).toBe(true);
    expect(
      detectNerdFonts('auto', {
        TERM_PROGRAM: 'Alacritty',
      }),
    ).toBe(true);
    expect(
      detectNerdFonts('auto', {
        TERM_PROGRAM: 'WarpTerminal',
      }),
    ).toBe(true);
  });

  test('auto detects kitty from TERM', () => {
    expect(
      detectNerdFonts('auto', {
        TERM: 'xterm-kitty',
      }),
    ).toBe(true);
  });

  test('auto defaults to false on unknown terminals', () => {
    expect(
      detectNerdFonts('auto', {
        TERM_PROGRAM: 'Terminal.app',
      }),
    ).toBe(false);
    expect(detectNerdFonts('auto', {})).toBe(false);
  });
});
