import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultVibesDir(): string {
  return join(homedir(), '.config', 'noetic', 'vibes');
}

export function loadVibesFromFile(theme: string, dir: string = defaultVibesDir()): string[] {
  const path = join(dir, `${theme}.txt`);
  try {
    const raw = readFileSync(path, 'utf8');
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  } catch {
    return [];
  }
}
