/**
 * Nerd Font detection.
 *
 * The environment variable `POWERLINE_NERD_FONTS` (values "1"/"0"/"true"/"false")
 * always wins. Otherwise we infer from `TERM_PROGRAM` — major modern terminals
 * ship Nerd Fonts by default. Everything else defaults to ASCII.
 */

import type { NerdFontsMode } from './options.js';

const NERD_CAPABLE_TERMS: ReadonlyArray<string> = [
  'iTerm.app',
  'WezTerm',
  'ghostty',
  'Ghostty',
  'kitty',
  'Alacritty',
  'WarpTerminal',
];

type Env = Record<string, string | undefined>;

export function detectNerdFonts(mode: NerdFontsMode, env: Env = process.env): boolean {
  if (mode === 'on') {
    return true;
  }
  if (mode === 'off') {
    return false;
  }
  return detectAuto(env);
}

function detectAuto(env: Env): boolean {
  const override = env.POWERLINE_NERD_FONTS?.toLowerCase();
  if (override === '1' || override === 'true') {
    return true;
  }
  if (override === '0' || override === 'false') {
    return false;
  }
  const termProgram = env.TERM_PROGRAM;
  if (typeof termProgram === 'string' && NERD_CAPABLE_TERMS.includes(termProgram)) {
    return true;
  }
  const term = env.TERM;
  if (typeof term === 'string' && term.includes('kitty')) {
    return true;
  }
  return false;
}
