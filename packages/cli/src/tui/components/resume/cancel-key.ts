import type { Key } from 'ink';

/** Esc and Ctrl+C both cancel — used by resume-screen and log-selector. */
export function shouldCancelOnKey(input: string, key: Pick<Key, 'escape' | 'ctrl'>): boolean {
  if (key.escape) {
    return true;
  }
  if (key.ctrl && input === 'c') {
    return true;
  }
  return false;
}
