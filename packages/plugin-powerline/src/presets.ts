import type { PresetName } from './options.js';

export const PRESETS: Record<PresetName, ReadonlyArray<string>> = {
  default: [
    'noetic',
    'model',
    'path',
    'git',
    'tokens',
    'context_pct',
  ],
  minimal: [
    'model',
    'path',
    'git',
  ],
  compact: [
    'model',
    'git',
    'context_pct',
  ],
  full: [
    'noetic',
    'model',
    'path',
    'git',
    'tokens',
    'context_pct',
    'session_time',
    'clock',
  ],
  nerd: [
    'noetic',
    'model',
    'path',
    'git',
    'tokens',
    'context_pct',
    'session_time',
  ],
  ascii: [
    'model',
    'path',
    'git',
    'tokens',
    'context_pct',
  ],
};
