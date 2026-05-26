//#region Constants

/**
 * Prefix used by ShellAdapter implementations to signal a timeout-induced
 * kill via the Error.message channel. Format: `${TIMEOUT_ERROR_PREFIX}${seconds}`.
 * Callers parse the seconds back out of `error.message`.
 *
 * @public
 */
export const TIMEOUT_ERROR_PREFIX = 'timeout:';

//#endregion

//#region Types

/** @public Options for a single shell command execution. */
export interface ShellExecOptions {
  /** Working directory for the command. */
  cwd: string;
  /** Environment variables (merged with process defaults for local, used directly for emulated). */
  env?: Record<string, string>;
  /** Timeout in seconds. */
  timeout?: number;
  /** Standard input to pipe into the command. */
  stdin?: string;
  /** Abort signal for cancellation support. */
  signal?: AbortSignal;
  /** Streaming callback invoked as output data arrives. */
  onData?: (data: Buffer) => void;
}

/** @public Result of a shell command execution. */
export interface ShellExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** @public Shell execution abstraction for agent runtime operations. */
export interface ShellAdapter {
  /** Execute a shell command string and return its result. */
  exec(command: string, options: ShellExecOptions): Promise<ShellExecResult>;
}

//#endregion
