import type { ShellAdapter, ShellExecResult } from '@noetic/core';
import { TIMEOUT_ERROR_PREFIX } from '@noetic/core';

//#region Types

/**
 * Options for `createLocalShellAdapter`.
 *
 * @public
 */
export interface CreateLocalShellAdapterOptions {
  /**
   * When `true`, every command is rewritten through `rtk rewrite`
   * (https://github.com/rtk-ai/rtk) before exec to filter and summarize
   * output for token efficiency. The rewrite is per-command — `rtk` decides
   * which programs it knows how to filter and falls back to the raw command
   * for unknown programs (exit 1, no output → original used).
   *
   * Defaults to `false` so non-CLI embedders keep raw shell semantics.
   * `@noetic/cli` opts in via `createDefaultShellAdapter`.
   *
   * Resolved against `PATH` once at adapter creation; the result is exposed
   * as `rtkAvailable` so callers can fail fast when this is required.
   */
  useRtk?: boolean;
}

/**
 * Local shell adapter — a `ShellAdapter` plus introspection for the rtk
 * wrapping decision so the harness factory can verify the binary is present
 * before it starts running tools.
 *
 * @public
 */
export interface LocalShellAdapter extends ShellAdapter {
  /** Whether `rtk` was found on PATH at adapter creation time. */
  readonly rtkAvailable: boolean;
  /** Resolved absolute path to `rtk`, or `null` when not on PATH. */
  readonly rtkPath: string | null;
  /** Whether wrapping with rtk is enabled (the constructor option). */
  readonly useRtk: boolean;
}

//#endregion

//#region Helpers

const RTK_REWRITE_TIMEOUT_MS = 2e3;

function readStream(
  stream: ReadableStream<Uint8Array>,
  onData?: (data: Buffer) => void,
): Promise<string> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();

  async function pump(): Promise<string> {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const buf = Buffer.from(value);
      chunks.push(buf);
      onData?.(buf);
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  return pump();
}

/**
 * Ask `rtk rewrite` to translate the raw command into its filtered form.
 *
 * Returns the rewritten command string when rtk knows how to wrap it
 * (exit 0, non-empty stdout). Returns `null` on any other outcome — exit 1
 * (rtk doesn't recognize the program), timeout, spawn failure — so the
 * caller falls through to the raw command. This mirrors the documented
 * hook contract: `REWRITTEN=$(rtk rewrite "$CMD") || exit 0`.
 */
async function rewriteWithRtk(rtkPath: string, command: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      [
        rtkPath,
        'rewrite',
        command,
      ],
      {
        stdout: 'pipe',
        stderr: 'ignore',
      },
    );

    const timeoutHandle = setTimeout(() => {
      proc.kill();
    }, RTK_REWRITE_TIMEOUT_MS);

    try {
      const [stdout, exitCode] = await Promise.all([
        readStream(proc.stdout),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        return null;
      }
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : null;
    } finally {
      clearTimeout(timeoutHandle);
    }
  } catch {
    return null;
  }
}

//#endregion

//#region Public API

/**
 * Create a `ShellAdapter` backed by the local system shell via `Bun.spawn`.
 *
 * Defaults to plain `sh -c` execution. Pass `{ useRtk: true }` to wrap each
 * command through `rtk rewrite` for token efficiency — best-effort: any
 * failure (rtk missing, exit 1, timeout) falls through to the raw command.
 * The CLI opts in via `createDefaultShellAdapter`; other embedders of
 * `@noetic/core` keep raw shell semantics unless they explicitly enable rtk.
 *
 * Call sites that want hard-fail semantics on missing rtk should read
 * `rtkAvailable` on the returned adapter and refuse to boot when it is
 * `false`.
 */
export function createLocalShellAdapter(opts?: CreateLocalShellAdapterOptions): LocalShellAdapter {
  const useRtk = opts?.useRtk ?? false;
  // Read PATH from process.env so tests can override it. `Bun.which(name)`
  // without an explicit PATH ignores subsequent process.env.PATH mutations.
  const rtkPath = useRtk
    ? (Bun.which('rtk', {
        PATH: process.env.PATH ?? '',
      }) ?? null)
    : null;
  const rtkAvailable = rtkPath !== null;

  async function exec(
    command: string,
    options: Parameters<ShellAdapter['exec']>[1],
  ): Promise<ShellExecResult> {
    let effectiveCommand = command;
    if (useRtk && rtkPath) {
      const rewritten = await rewriteWithRtk(rtkPath, command);
      if (rewritten) {
        effectiveCommand = rewritten;
      }
    }

    const proc = Bun.spawn(
      [
        'sh',
        '-c',
        effectiveCommand,
      ],
      {
        cwd: options.cwd,
        env: options.env
          ? {
              ...process.env,
              ...options.env,
            }
          : undefined,
        stdin: options.stdin
          ? new Blob([
              options.stdin,
            ])
          : undefined,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutSeconds = options.timeout;
    if (timeoutSeconds !== undefined && timeoutSeconds > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutSeconds * 1e3);
    }

    const abortHandler = (): void => {
      proc.kill();
    };
    if (options.signal) {
      options.signal.addEventListener('abort', abortHandler, {
        once: true,
      });
    }

    try {
      const [stdout, stderr] = await Promise.all([
        readStream(proc.stdout, options.onData),
        readStream(proc.stderr, options.onData),
      ]);

      const exitCode = await proc.exited;

      // Only timeout throws. Signal-driven aborts resolve normally so
      // callers can decide via their own state whether the result is
      // a real exit or a cancellation (see runUserShellCommand).
      if (timedOut) {
        throw new Error(`${TIMEOUT_ERROR_PREFIX}${timeoutSeconds}`);
      }

      return {
        stdout,
        stderr,
        exitCode,
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  return {
    exec,
    rtkAvailable,
    rtkPath,
    useRtk,
  };
}

//#endregion
