/**
 * Display-path helpers shared across TUI components.
 */

import { homedir } from 'node:os';

const HOME = homedir();

/** Rewrite an absolute path under $HOME to a `~`-prefixed display form. */
export function relativizeHome(absolutePath: string): string {
  if (!HOME || !absolutePath.startsWith(HOME)) {
    return absolutePath;
  }
  return `~${absolutePath.slice(HOME.length)}`;
}
