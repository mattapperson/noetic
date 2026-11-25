/**
 * Node stdio transport — the standard way to reach a local ACP agent.
 *
 * Lives behind the `@noetic-tools/acp/stdio` subpath so the package's main
 * entry stays runtime-neutral: nothing in `.` imports `node:*`, and a browser
 * bundle never pulls in `child_process`. The agent presets reach this through a
 * lazy dynamic import, so `claudeCode()` works with no extra wiring while
 * keeping the dependency off the main graph.
 */

import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type {
  AcpMachine,
  AcpMachineFactory,
  AcpTransport,
  AcpTransportFactory,
  SpawnCommand,
} from '@noetic-tools/types';
import { AcpConnectError, frameworkCast } from '@noetic-tools/types';
import { serverEnv } from './server-env';
import { stopProcessTree } from './stdio-process';

export type { StopProcessTreeOptions } from './stdio-process';
export { stopProcessTree, TERM_GRACE_MS } from './stdio-process';

/** @public How to launch an ACP agent as a child process. */
export interface StdioAgentSpec {
  /** Identifier used in error messages. */
  agentId: string;
  /** Executable to run (often `npx` or a globally installed CLI). */
  command: string;
  args?: ReadonlyArray<string>;
  /** Environment overrides layered onto the parent environment. */
  env?: Record<string, string | undefined>;
}

/**
 * Build a transport factory that spawns `spec.command` and speaks ACP over its
 * stdin/stdout. The child's stderr is inherited so agent diagnostics reach the
 * host's logs instead of vanishing. Closing the transport (or aborting its
 * signal) closes the pipes and stops the agent's whole process group —
 * SIGTERM, a grace period, then SIGKILL; on Windows, its process tree. Close
 * is idempotent: every call shares one shutdown.
 * @public
 */
export function stdioAcpTransport(spec: StdioAgentSpec): AcpTransportFactory {
  return async (opts): Promise<AcpTransport> =>
    spawnStdio(
      spec.agentId,
      {
        command: spec.command,
        args: spec.args,
        env: {
          ...process.env,
          ...spec.env,
          ...opts.env,
        },
        cwd: opts.cwd,
      },
      opts.signal,
    );
}

/**
 * This machine: the bridge is reached on its own loopback address, and the
 * agent and any MCP server beside it run as child processes. The agent gets
 * this process's environment; an MCP server, as the MCP SDK starts one, only
 * `serverEnv`'s short list.
 * @public
 */
export function localMachine(agentId = 'local'): AcpMachineFactory {
  return async ({ signal }): Promise<AcpMachine> => {
    const started = new Set<AcpTransport>();
    const start = async (
      command: SpawnCommand,
      env: Record<string, string | undefined>,
    ): Promise<AcpTransport> => {
      const transport = await spawnStdio(
        agentId,
        {
          ...command,
          env,
        },
        signal,
      );
      started.add(transport);
      return transport;
    };
    return {
      reach: async (bridge) => bridge,
      launch: (command) =>
        start(command, {
          ...process.env,
          ...command.env,
        }),
      spawn: (command) => start(command, serverEnv(command.env)),
      async close() {
        // In parallel: each stop may take its whole grace period.
        const closing = [
          ...started,
        ].map((transport) => transport.close().catch(() => undefined));
        started.clear();
        await Promise.all(closing);
      },
    };
  };
}

/**
 * Spawn `command` with exactly its `env` and carry its stdin/stdout as a byte
 * stream. The child leads its own process group (POSIX), so closing or
 * aborting stops everything it started — a wrapper's native grandchild
 * included — and releases the pipes; see `stopProcessTree`. A missing binary
 * or a signal that is already aborted rejects here, not at `close()`.
 */
async function spawnStdio(
  agentId: string,
  command: SpawnCommand,
  signal: AbortSignal | undefined,
): Promise<AcpTransport> {
  const fail = (message: string, cause: unknown): AcpConnectError =>
    new AcpConnectError({
      agentId,
      message: `ACP agent '${agentId}' (${command.command}) ${message}.`,
      cause,
    });
  if (signal?.aborted) {
    throw fail('was not started: the launch was already aborted', signal.reason);
  }
  const child = spawn(
    command.command,
    [
      ...(command.args ?? []),
    ],
    {
      cwd: command.cwd,
      env: command.env,
      stdio: [
        'pipe',
        'pipe',
        'inherit',
      ],
      // Its own process group, so shutdown can signal the whole tree without
      // ever signalling the host's group. Windows stops the tree by pid.
      detached: process.platform !== 'win32',
      windowsHide: true,
    },
  );

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    signal?.removeEventListener('abort', onAbort);
    closing ??= stopProcessTree(child).catch((error: unknown) => {
      throw fail('could not be stopped', error);
    });
    return closing;
  };
  const onAbort = (): void => {
    // An explicit close() still observes a failure; this only keeps it handled.
    void close().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, {
    once: true,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (error) {
    await close().catch(() => undefined);
    throw fail('failed to start', error);
  }
  // A late error (a broken pipe after spawn) must not escape as an unhandled
  // 'error' event; the stream ending reports it to the connection.
  child.on('error', () => undefined);
  // Shutdown destroys our ends of the pipes, possibly mid-read; the web
  // streams report that to their reader, so the Node-side error is handled.
  child.stdin?.on('error', () => undefined);
  child.stdout?.on('error', () => undefined);
  if (signal?.aborted) {
    await close().catch(() => undefined);
    throw fail('was aborted while starting', signal.reason);
  }

  const stdin = child.stdin;
  const stdout = child.stdout;
  if (!stdin || !stdout) {
    await close().catch(() => undefined);
    throw fail('was spawned without usable stdio pipes', undefined);
  }

  return {
    // `node:stream`'s web-stream types are structurally the same as the
    // global ones but nominally distinct, so the bridge is cast once here
    // rather than leaking a Node-specific type through the transport contract.
    readable: frameworkCast<ReadableStream<Uint8Array>>(Readable.toWeb(stdout)),
    writable: frameworkCast<WritableStream<Uint8Array>>(Writable.toWeb(stdin)),
    close,
  };
}
