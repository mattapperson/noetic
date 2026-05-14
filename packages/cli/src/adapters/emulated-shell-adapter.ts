/**
 * Emulated shell adapter backed by just-bash.
 *
 * Provides a sandboxed shell environment that uses a pure TypeScript
 * bash implementation instead of real OS processes. The filesystem
 * is bridged to Noetic's FsAdapter so emulated commands see the
 * same files as the framework.
 *
 * Limitations:
 * - onData fires once after execution completes (no incremental streaming)
 * - Each exec call creates a fresh Bash instance to avoid shared-state races
 */

import type { FsAdapter, ShellAdapter, ShellExecResult } from '@noetic-tools/core';
import { Bash } from 'just-bash';
import { createBridgedFs } from './fs-adapter-bridge.js';

//#region Types

interface EmulatedShellOptions {
  /** FsAdapter to bridge into just-bash's filesystem. */
  fs: FsAdapter;
  /** Default environment variables. */
  env?: Record<string, string>;
  /** Default working directory. */
  cwd?: string;
}

//#endregion

//#region Public API

/** Create a ShellAdapter backed by just-bash's emulated shell. */
export function createEmulatedShellAdapter(options: EmulatedShellOptions): ShellAdapter {
  const bridgedFs = createBridgedFs(options.fs);
  const defaultEnv = options.env;
  const defaultCwd = options.cwd;

  return {
    async exec(command, execOptions): Promise<ShellExecResult> {
      // Create a fresh Bash instance per exec to avoid shared-state races
      // when multiple commands run concurrently (e.g., Promise.allSettled)
      const bash = new Bash({
        fs: bridgedFs,
        env: defaultEnv,
        cwd: defaultCwd,
      });

      // Use AbortSignal.timeout for wall-clock timeout, merged with caller's signal
      const timeoutMs = execOptions.timeout ? execOptions.timeout * 1e3 : undefined;
      const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
      const signal =
        execOptions.signal && timeoutSignal
          ? AbortSignal.any([
              execOptions.signal,
              timeoutSignal,
            ])
          : (execOptions.signal ?? timeoutSignal);

      const result = await bash.exec(command, {
        cwd: execOptions.cwd,
        env: execOptions.env,
        stdin: execOptions.stdin,
        signal,
      });

      if (execOptions.onData) {
        const combined = result.stdout + result.stderr;
        if (combined) {
          execOptions.onData(Buffer.from(combined));
        }
      }

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
  };
}

//#endregion
