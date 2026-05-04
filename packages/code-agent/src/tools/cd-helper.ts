/**
 * Pure cd-resolution helpers shared by the agent's Bash tool and the TUI's
 * local `!`-prefix shell. No I/O beyond a `statSync` to validate the target.
 */

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { getFirstCommand } from './security.js';

//#region Types

export interface HandleCdArgs {
  arg: string | undefined;
  effectiveCwd: string;
  prevCwd: string | null;
  /** Override for tests; defaults to `os.homedir()`. */
  home?: string;
}

export interface CdSuccess {
  kind: 'ok';
  previousCwd: string;
  newCwd: string;
}

export interface CdFailure {
  kind: 'error';
  message: string;
}

export type CdResult = CdSuccess | CdFailure;

//#endregion

//#region Command splitting

/**
 * True iff `command` is a single `cd <arg>` invocation (or bare `cd`),
 * with no shell metacharacters that would chain or pipe additional commands.
 *
 * The Bash tool only short-circuits plain `cd`; compound forms must go
 * through the shell because (per POSIX) cwd from a subprocess shell does
 * not propagate to subsequent commands anyway.
 */
export function isPlainCdCommand(command: string): boolean {
  if (getFirstCommand(command) !== 'cd') {
    return false;
  }
  const rest = command.trim().slice(2).trim();
  if (rest.length === 0) {
    return true;
  }
  // A matched pair of surrounding quotes needs ≥ 2 chars (the same quote at
  // each end). A single `'` or `"` is an unmatched quote and falls through
  // to the metachar check, which rejects it.
  if (
    rest.length >= 2 &&
    ((rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'")))
  ) {
    return true;
  }
  // Reject shell control chars that chain commands or require shell expansion,
  // and unmatched quotes that the in-process handler cannot parse correctly.
  return !/["'&|;<>`$()]/.test(rest);
}

/**
 * Extract the single argument to `cd` (everything after `cd` and whitespace).
 * Returns undefined for a bare `cd`. Does NOT shell-unquote — quoted paths
 * with spaces are passed through as-is; we rely on stat to catch bad paths.
 */
export function parseCdArg(command: string): string | undefined {
  const trimmed = command.trimStart();
  if (!/^cd(\s|$)/.test(trimmed)) {
    return undefined;
  }
  const rest = trimmed.slice(2).trim();
  if (rest.length === 0) {
    return undefined;
  }
  if (
    (rest.startsWith('"') && rest.endsWith('"')) ||
    (rest.startsWith("'") && rest.endsWith("'"))
  ) {
    return rest.slice(1, -1);
  }
  return rest;
}

//#endregion

//#region cd handler

/**
 * Resolve a `cd` argument against the effective cwd, with ~ expansion,
 * `-` (previous) support, and existence/dir validation.
 */
export function handleCd(args: HandleCdArgs): CdResult {
  const { arg, effectiveCwd, prevCwd } = args;
  const home = args.home ?? homedir();

  const target = resolveCdTarget({
    arg,
    effectiveCwd,
    prevCwd,
    home,
  });
  if (target.kind === 'error') {
    return target;
  }

  try {
    if (!statSync(target.path).isDirectory()) {
      return {
        kind: 'error',
        message: `cd: not a directory: ${target.path}`,
      };
    }
  } catch {
    return {
      kind: 'error',
      message: `cd: no such file or directory: ${target.path}`,
    };
  }

  if (target.path === effectiveCwd) {
    return {
      kind: 'ok',
      previousCwd: prevCwd ?? effectiveCwd,
      newCwd: effectiveCwd,
    };
  }

  return {
    kind: 'ok',
    previousCwd: effectiveCwd,
    newCwd: target.path,
  };
}

interface CdTargetPath {
  kind: 'path';
  path: string;
}

interface ResolveCdTargetArgs {
  arg: string | undefined;
  effectiveCwd: string;
  prevCwd: string | null;
  home: string;
}

function resolveCdTarget(args: ResolveCdTargetArgs): CdTargetPath | CdFailure {
  const { arg, effectiveCwd, prevCwd, home } = args;
  if (arg === undefined) {
    return {
      kind: 'path',
      path: home,
    };
  }
  if (arg === '-') {
    if (prevCwd === null) {
      return {
        kind: 'error',
        message: 'cd: OLDPWD not set',
      };
    }
    return {
      kind: 'path',
      path: prevCwd,
    };
  }
  if (arg === '~') {
    return {
      kind: 'path',
      path: home,
    };
  }
  if (arg.startsWith('~/')) {
    return {
      kind: 'path',
      path: resolve(home, arg.slice(2)),
    };
  }
  if (isAbsolute(arg)) {
    return {
      kind: 'path',
      path: resolve(arg),
    };
  }
  return {
    kind: 'path',
    path: resolve(effectiveCwd, arg),
  };
}

//#endregion
