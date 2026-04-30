/**
 * Path expansion and resolution utilities.
 *
 * Ported from: https://github.com/OpenRouterTeam/sky
 */

import { accessSync, constants } from 'node:fs';
import * as os from 'node:os';
import { isAbsolute, resolve as resolvePath } from 'node:path';

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = '\u202F';

function normalizeUnicodeSpaces(str: string): string {
  return str.replace(UNICODE_SPACES, ' ');
}

function tryMacOsScreenshotPath(filePath: string): string {
  return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function fileExists(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function expandPath(filePath: string): string {
  const normalized = normalizeUnicodeSpaces(filePath);
  if (normalized === '~') {
    return os.homedir();
  }
  if (normalized.startsWith('~/')) {
    return os.homedir() + normalized.slice(1);
  }
  return normalized;
}

export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (isAbsolute(expanded)) {
    return expanded;
  }
  return resolvePath(cwd, expanded);
}

/**
 * Quote a value for inclusion as a single shell argument. Wraps in single
 * quotes and escapes any embedded single quotes via the standard `'\''` idiom.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function resolveReadPath(filePath: string, cwd: string): string {
  const resolved = resolveToCwd(filePath, cwd);

  if (fileExists(resolved)) {
    return resolved;
  }

  const macOsVariant = tryMacOsScreenshotPath(resolved);
  if (macOsVariant !== resolved && fileExists(macOsVariant)) {
    return macOsVariant;
  }

  return resolved;
}
