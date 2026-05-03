/**
 * Shared helpers for shell-out call sites in the task system. Two
 * concerns these utilities collapse:
 *
 *   1. Detecting "command missing" — the local shell adapter signals it
 *      via either a synthetic exit-127 result OR an ENOENT-shaped
 *      thrown Error, depending on the platform. Callers want to react
 *      uniformly (fall back to a different tool, surface a friendly
 *      "X is not on PATH" message).
 *   2. Normalising both signals into a single `ShellExecResult` so the
 *      branch-on-result code at the call site stays flat.
 */

import type { ShellAdapter, ShellExecResult } from '@noetic/core';

import { isErrorWithCode } from './_fs-errors.js';

//#region isShellMissing

/**
 * Treat exit 127 OR a "command not found" / "no such file" stderr as
 * the shell's way of saying the binary isn't on PATH. POSIX shells
 * use 127 consistently; some sandboxes return a generic non-zero with
 * the text in stderr, which is what the regex covers.
 */
export function isShellMissing(result: ShellExecResult): boolean {
  if (result.exitCode === 127) {
    return true;
  }
  return /command\s+not\s+found|no\s+such\s+file/i.test(result.stderr);
}

//#endregion

//#region execTolerantOfMissing

/**
 * Run `command` via {@link ShellAdapter.exec}, normalising a thrown
 * `ENOENT` into a synthetic exit-127 `ShellExecResult` so the caller
 * can branch on `result.exitCode` regardless of which signal the
 * platform raised. Detection uses `err.code === 'ENOENT'` (Node's
 * structural signal) rather than message matching, so locale or
 * runtime variations in error text do not break the fallback.
 * Other thrown errors propagate unchanged.
 */
export async function execTolerantOfMissing(
  shell: ShellAdapter,
  command: string,
  cwd: string,
): Promise<ShellExecResult> {
  try {
    return await shell.exec(command, {
      cwd,
    });
  } catch (err) {
    if (isErrorWithCode(err) && err.code === 'ENOENT') {
      return {
        stdout: '',
        stderr: err.message,
        exitCode: 127,
      };
    }
    throw err;
  }
}

//#endregion
