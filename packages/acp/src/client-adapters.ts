/**
 * Platform adapters backed by the ACP *client* — the server direction's
 * inversion of the client-side handlers. A served harness built on these
 * routes its file reads through the editor (seeing unsaved buffer state, the
 * point of ACP's client-side filesystem) and its shell commands through the
 * editor's terminals.
 *
 * The wire only carries `fs/read_text_file`, `fs/write_text_file`, and
 * `terminal/*`, so these adapters are honest about their limits: an operation
 * with no wire representation (binary writes, stat, readdir, …) rejects with
 * {@link AcpCapabilityError} rather than pretending, and a factory author who
 * needs those falls back to a local adapter for them.
 */

import type { FsAdapter, FsStats, ShellAdapter, ShellExecResult } from '@noetic-tools/types';
import { AcpCapabilityError, frameworkCast, TIMEOUT_ERROR_PREFIX } from '@noetic-tools/types';
import type * as acp from '@zed-industries/agent-client-protocol';
import type { AgentSideConnection } from '@zed-industries/agent-client-protocol';

const CLIENT_AGENT_ID = 'acp-client';

function unsupported(capability: string): AcpCapabilityError {
  return new AcpCapabilityError({
    agentId: CLIENT_AGENT_ID,
    capability,
    message: `the ACP client cannot back '${capability}' — it has no wire representation`,
  });
}

function notAdvertised(capability: string): AcpCapabilityError {
  return new AcpCapabilityError({
    agentId: CLIENT_AGENT_ID,
    capability,
  });
}

/**
 * UTF-8 bytes without assuming a Node runtime: the `.` entry is
 * runtime-neutral, and the `Buffer` global (which `FsAdapter`'s contract
 * names) only exists under Node/Bun — elsewhere a structurally-compatible
 * `Uint8Array` is the best the platform offers.
 */
function toBytes(text: string): Buffer {
  const BufferCtor = frameworkCast<
    | {
        from(input: string, encoding: string): Buffer;
      }
    | undefined
  >(frameworkCast<Record<string, unknown>>(globalThis).Buffer);
  if (BufferCtor) {
    return BufferCtor.from(text, 'utf8');
  }
  return frameworkCast<Buffer>(new TextEncoder().encode(text));
}

/** Errors that read as "file does not exist", across adapters and clients. */
const NOT_FOUND_RE = /enoent|not found|no such file|does not exist/i;

/**
 * Whether a read failure means "the file does not exist". The wire wraps the
 * client adapter's error as a generic JSON-RPC internal error with the detail
 * in `data`, so the serialized error is scanned, not just the message.
 */
function looksLikeMissingFile(e: unknown): boolean {
  if (e instanceof Error && NOT_FOUND_RE.test(e.message)) {
    return true;
  }
  try {
    return NOT_FOUND_RE.test(JSON.stringify(e));
  } catch {
    return false;
  }
}

//#region Filesystem

/** @public Options for {@link clientFsAdapter}. */
export interface ClientFsAdapterOptions {
  conn: AgentSideConnection;
  sessionId: string;
  capabilities: acp.ClientCapabilities | undefined;
}

/**
 * An `FsAdapter` over the client's `fs/read_text_file` / `fs/write_text_file`.
 * Text reads and writes hit the editor (unsaved buffers included); everything
 * the wire cannot express rejects with {@link AcpCapabilityError}.
 * @public
 */
export function clientFsAdapter(options: ClientFsAdapterOptions): FsAdapter {
  const { conn, sessionId, capabilities } = options;
  const canRead = capabilities?.fs?.readTextFile === true;
  const canWrite = capabilities?.fs?.writeTextFile === true;

  const readFileText = async (path: string): Promise<string> => {
    if (!canRead) {
      throw notAdvertised('fs.readTextFile');
    }
    const response = await conn.readTextFile({
      sessionId,
      path,
    });
    return response.content;
  };

  const writeFile = async (path: string, content: string): Promise<void> => {
    if (!canWrite) {
      throw notAdvertised('fs.writeTextFile');
    }
    await conn.writeTextFile({
      sessionId,
      path,
      content,
    });
  };

  return {
    readFileText,
    writeFile,
    async readFile(path: string): Promise<Buffer> {
      return toBytes(await readFileText(path));
    },
    async appendFile(path: string, content: string): Promise<void> {
      let existing = '';
      try {
        existing = await readFileText(path);
      } catch (e) {
        // Only a genuinely-missing file appends from empty (matching local
        // adapters). Any OTHER read failure — transport error, permission
        // denial, path confinement — must propagate: writing just the
        // fragment would silently truncate a file we failed to read.
        if (e instanceof AcpCapabilityError || !looksLikeMissingFile(e)) {
          throw e;
        }
      }
      await writeFile(path, `${existing}${content}`);
    },
    async mkdir(): Promise<void> {
      // No directory method exists on the wire; ACP clients create parent
      // directories on write, so this is a deliberate no-op rather than a
      // refusal — refusing would break every write-through-mkdir call path.
    },
    writeFileBytes(): Promise<void> {
      return Promise.reject(unsupported('fs.writeFileBytes'));
    },
    rename(): Promise<void> {
      return Promise.reject(unsupported('fs.rename'));
    },
    rm(): Promise<void> {
      return Promise.reject(unsupported('fs.rm'));
    },
    access(): Promise<void> {
      return Promise.reject(unsupported('fs.access'));
    },
    stat(): Promise<FsStats> {
      return Promise.reject(unsupported('fs.stat'));
    },
    lstat(): Promise<FsStats> {
      return Promise.reject(unsupported('fs.lstat'));
    },
    readdir(): Promise<string[]> {
      return Promise.reject(unsupported('fs.readdir'));
    },
  };
}

//#endregion

//#region Shell

/** @public Options for {@link clientShellAdapter}. */
export interface ClientShellAdapterOptions {
  conn: AgentSideConnection;
  sessionId: string;
  capabilities: acp.ClientCapabilities | undefined;
  /** Shell used to run the command string. Default `/bin/sh -c`. */
  shell?: [
    string,
    ...string[],
  ];
}

/**
 * A `ShellAdapter` over the client's `terminal/*` methods: each `exec` runs
 * in an editor-owned terminal, so the user watches the command live.
 * @public
 */
export function clientShellAdapter(options: ClientShellAdapterOptions): ShellAdapter {
  const { conn, sessionId, capabilities } = options;
  const [shellCommand, ...shellArgs] = options.shell ?? [
    '/bin/sh',
    '-c',
  ];

  return {
    async exec(command, execOptions): Promise<ShellExecResult> {
      if (capabilities?.terminal !== true) {
        throw notAdvertised('terminal');
      }
      if (execOptions.stdin !== undefined) {
        throw unsupported('terminal.stdin');
      }
      // Matches the local adapter's contract: a signal abort (including an
      // already-aborted signal) RESOLVES with what was collected; only a
      // timeout rejects, with the TIMEOUT_ERROR_PREFIX message callers parse.
      if (execOptions.signal?.aborted) {
        return {
          stdout: '',
          stderr: '',
          exitCode: null,
        };
      }
      const terminal = await conn.createTerminal({
        sessionId,
        command: shellCommand,
        args: [
          ...shellArgs,
          command,
        ],
        cwd: execOptions.cwd,
        env: Object.entries(execOptions.env ?? {}).map(([name, value]) => ({
          name,
          value,
        })),
      });
      let timedOut = false;
      const stop = (): void => {
        void terminal.kill().catch(() => undefined);
      };
      const timer =
        execOptions.timeout !== undefined
          ? setTimeout(() => {
              timedOut = true;
              stop();
            }, execOptions.timeout * 1e3)
          : undefined;
      execOptions.signal?.addEventListener('abort', stop, {
        once: true,
      });
      try {
        const exit = await terminal.waitForExit();
        const output = await terminal.currentOutput();
        if (timedOut) {
          throw new Error(`${TIMEOUT_ERROR_PREFIX}${execOptions.timeout}`);
        }
        execOptions.onData?.(toBytes(output.output));
        return {
          stdout: output.output,
          stderr: '',
          exitCode: exit.exitCode ?? null,
        };
      } finally {
        clearTimeout(timer);
        execOptions.signal?.removeEventListener('abort', stop);
        await terminal.release().catch(() => undefined);
      }
    },
  };
}

//#endregion
