/**
 * Theme loader. Reads a user JSON file that overrides individual palette keys
 * and merges it over `DEFAULT_THEME`. Invalid files fall back to defaults.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { PaletteKey } from './colors.js';
import { DEFAULT_THEME } from './colors.js';

export type Theme = Record<PaletteKey, string>;

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const ThemeFileSchema = z.record(z.string(), HexColorSchema);

export function defaultThemePath(): string {
  return join(homedir(), '.config', 'noetic', 'powerline-theme.json');
}

export function loadTheme(path?: string): Theme {
  const resolved = path ?? defaultThemePath();
  try {
    const raw = readFileSync(resolved, 'utf8');
    const validated = ThemeFileSchema.safeParse(JSON.parse(raw));
    if (!validated.success) {
      return {
        ...DEFAULT_THEME,
      };
    }
    return mergeTheme(DEFAULT_THEME, validated.data);
  } catch {
    return {
      ...DEFAULT_THEME,
    };
  }
}

function mergeTheme(base: Theme, overrides: Record<string, string>): Theme {
  const merged: Theme = {
    ...base,
  };
  for (const key of Object.keys(base)) {
    if (!isPaletteKey(base, key)) {
      continue;
    }
    const override = overrides[key];
    if (typeof override === 'string') {
      merged[key] = override;
    }
  }
  return merged;
}

function isPaletteKey(base: Theme, key: string): key is PaletteKey {
  return Object.hasOwn(base, key);
}
