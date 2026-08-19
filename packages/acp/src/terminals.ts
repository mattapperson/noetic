/**
 * Backs the ACP `terminal/*` client methods with Noetic's {@link ShellAdapter}.
 *
 * ACP models a terminal as a long-lived handle the agent creates, polls, waits
 * on, kills, and releases. `ShellAdapter.exec` is a single call that streams
 * through `onData`, so this registry brackets one `exec` per terminal and
 * exposes the handle semantics on top of it. Everything the sub-agent runs
 * therefore goes through the same shell adapter as first-party steps.
 */

import type { ShellAdapter } from '@noetic-tools/types';

//#region Types

/** @public A single environment entry as ACP transmits it. */
export interface AcpEnvVariable {
  name: string;
  value: string;
}

/** @public Exit status of a finished terminal command. */
export interface AcpTerminalExitStatus {
  exitCode: number | null;
  signal: string | null;
}

/** @public Options for {@link TerminalRegistry.create}. */
export interface CreateTerminalOptions {
  command: string;
  args?: ReadonlyArray<string>;
  cwd?: string | null;
  env?: ReadonlyArray<AcpEnvVariable>;
  /** Cap on retained output. Older bytes are dropped first. */
  outputByteLimit?: number | null;
}

/** @public Snapshot of a terminal's captured output. */
export interface TerminalOutputSnapshot {
  output: string;
  truncated: boolean;
  exitStatus: AcpTerminalExitStatus | null;
}

interface TerminalRecord {
  readonly id: string;
  readonly abort: AbortController;
  readonly byteLimit?: number;
  /** Assigned immediately after construction, once the record can be closed over. */
  done: Promise<void>;
  /** Retained output, already trimmed to `byteLimit`. */
  output: Buffer;
  truncated: boolean;
  /**
   * Set by `kill()`. The exit status cannot be derived from how `exec` settled:
   * the shipped local adapter RESOLVES on a signal-driven abort (only a timeout
   * rejects), so inferring "killed" from a rejection reported a clean exit for
   * every killed command.
   */
  killed: boolean;
  exitStatus: AcpTerminalExitStatus | null;
}

//#endregion

//#region Helpers

/**
 * POSIX single-quote escaping. `ShellAdapter.exec` takes one command string
 * while ACP supplies `command` + `args`, so arguments are quoted rather than
 * concatenated — otherwise a path with a space would silently split.
 */
export function quoteShellArg(arg: string): string {
  if (/^[\w./:=@-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Build the single command string `ShellAdapter.exec` expects. */
export function buildCommandLine(command: string, args?: ReadonlyArray<string>): string {
  if (!args || args.length === 0) {
    return command;
  }
  return [
    quoteShellArg(command),
    ...args.map(quoteShellArg),
  ].join(' ');
}

function toEnvRecord(env?: ReadonlyArray<AcpEnvVariable>): Record<string, string> | undefined {
  if (!env || env.length === 0) {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const entry of env) {
    record[entry.name] = entry.value;
  }
  return record;
}

/** The status of a command we killed, whichever way `exec` chose to settle. */
const KILLED_STATUS: AcpTerminalExitStatus = {
  exitCode: null,
  signal: 'SIGTERM',
};

/**
 * Exit status for a rejected `exec`. The adapter signals a timeout kill through
 * the message channel, which ACP represents as a signal rather than a code.
 */
function exitStatusFromError(error: unknown): AcpTerminalExitStatus {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('timeout:')) {
    return {
      exitCode: null,
      signal: 'SIGTERM',
    };
  }
  return {
    exitCode: 1,
    signal: null,
  };
}

/**
 * Trim to the last `limit` bytes, then forward past any UTF-8 continuation
 * bytes so the result never starts mid-character.
 *
 * ACP asks the client to truncate *from the beginning of the output*; dropping
 * whole chunks instead meant one over-limit chunk destroyed the entire buffer —
 * a `npm test` producing megabytes could read back empty.
 */
function trimToLimit(buffer: Buffer, limit: number): Buffer {
  if (buffer.byteLength <= limit) {
    return buffer;
  }
  let start = buffer.byteLength - limit;
  while (start < buffer.byteLength && (buffer[start] & 0xc0) === 0x80) {
    start++;
  }
  return buffer.subarray(start);
}

//#endregion

//#region Registry

/**
 * Owns every terminal an ACP session created. One instance per session, torn
 * down with the session so no child command outlives the step that spawned it.
 * @public
 */
export class TerminalRegistry {
  private readonly terminals = new Map<string, TerminalRecord>();
  private nextId = 0;
  private disposed = false;

  constructor(
    private readonly shell: ShellAdapter,
    private readonly defaultCwd: string,
  ) {}

  /** Start a command and return its handle id. */
  create(opts: CreateTerminalOptions): string {
    if (this.disposed) {
      // Closing the connection is supposed to guarantee no command outlives it;
      // spawning one during or after teardown would orphan a child process.
      throw new Error('cannot create a terminal: the ACP connection is closing');
    }
    const id = `acp-term-${this.nextId++}`;
    const byteLimit =
      typeof opts.outputByteLimit === 'number' && opts.outputByteLimit > 0
        ? opts.outputByteLimit
        : undefined;

    const record: TerminalRecord = {
      id,
      abort: new AbortController(),
      byteLimit,
      done: Promise.resolve(),
      output: Buffer.alloc(0),
      truncated: false,
      killed: false,
      exitStatus: null,
    };
    this.terminals.set(id, record);
    record.done = this.run(record, opts);
    return id;
  }

  /** Drive one `exec` to completion, folding its output into the record. */
  private async run(record: TerminalRecord, opts: CreateTerminalOptions): Promise<void> {
    try {
      const result = await this.shell.exec(buildCommandLine(opts.command, opts.args), {
        cwd: opts.cwd ?? this.defaultCwd,
        env: toEnvRecord(opts.env),
        signal: record.abort.signal,
        onData: (data) => {
          appendChunk(record, data);
        },
      });
      // A shell adapter that buffers rather than streams reports its output
      // only here; append it when `onData` delivered nothing.
      if (record.output.byteLength === 0) {
        const combined = `${result.stdout}${result.stderr}`;
        if (combined.length > 0) {
          appendChunk(record, Buffer.from(combined, 'utf8'));
        }
      }
      // `killed` is the authority, not how `exec` settled: the local adapter
      // resolves normally on a signal-driven abort.
      record.exitStatus = record.killed
        ? KILLED_STATUS
        : {
            exitCode: result.exitCode,
            signal: null,
          };
    } catch (error) {
      record.exitStatus = record.killed ? KILLED_STATUS : exitStatusFromError(error);
    }
  }

  /** Current output and exit status, or `null` when the handle is unknown. */
  output(id: string): TerminalOutputSnapshot | null {
    const record = this.terminals.get(id);
    if (!record) {
      return null;
    }
    return {
      output: record.output.toString('utf8'),
      truncated: record.truncated,
      exitStatus: record.exitStatus,
    };
  }

  /** Resolve once the command has exited. */
  async waitForExit(id: string): Promise<AcpTerminalExitStatus | null> {
    const record = this.terminals.get(id);
    if (!record) {
      return null;
    }
    await record.done;
    return record.exitStatus;
  }

  /** Kill the command but keep the handle readable, per the ACP contract. */
  async kill(id: string): Promise<boolean> {
    const record = this.terminals.get(id);
    if (!record) {
      return false;
    }
    record.killed = true;
    record.abort.abort();
    await record.done;
    return true;
  }

  /** Kill the command and drop the handle. */
  async release(id: string): Promise<boolean> {
    const killed = await this.kill(id);
    this.terminals.delete(id);
    return killed;
  }

  /** Release every live terminal. Called when the session closes. */
  async releaseAll(): Promise<void> {
    this.disposed = true;
    const ids = [
      ...this.terminals.keys(),
    ];
    await Promise.all(ids.map((id) => this.release(id)));
  }
}

/** Append output, dropping the oldest BYTES once the cap is exceeded. */
function appendChunk(record: TerminalRecord, data: Buffer): void {
  const combined = Buffer.concat([
    record.output,
    data,
  ]);
  const limit = record.byteLimit;
  if (limit === undefined) {
    record.output = combined;
    return;
  }
  const trimmed = trimToLimit(combined, limit);
  if (trimmed.byteLength < combined.byteLength) {
    record.truncated = true;
  }
  record.output = trimmed;
}

//#endregion
