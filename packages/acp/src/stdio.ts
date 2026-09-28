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
import type { AcpTransport, AcpTransportFactory } from '@noetic-tools/types';
import { AcpConnectError, frameworkCast } from '@noetic-tools/types';

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
 * host's logs instead of vanishing.
 * @public
 */
const GRACE_MS = 750;

/** Stop a launcher and its descendants without signaling the host's process group. */
function signalTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      // taskkill handles a wrapped executable's descendants; /F is the force step.
      const killer = spawn(
        'taskkill',
        [
          '/PID',
          String(pid),
          '/T',
          ...(signal === 'SIGKILL'
            ? [
                '/F',
              ]
            : []),
        ],
        {
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      killer.on('error', () => undefined);
      killer.unref();
    } else {
      process.kill(-pid, signal); // detached child is leader of its own group
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
}

export function stdioAcpTransport(spec: StdioAgentSpec): AcpTransportFactory {
  return async (opts): Promise<AcpTransport> => {
    if (opts.signal?.aborted) {
      throw new AcpConnectError({
        agentId: spec.agentId,
        message: `ACP agent '${spec.agentId}' was cancelled before launch.`,
      });
    }
    const child = spawn(
      spec.command,
      [
        ...(spec.args ?? []),
      ],
      {
        cwd: opts.cwd,
        env: {
          ...process.env,
          ...spec.env,
          ...opts.env,
        },
        stdio: [
          'pipe',
          'pipe',
          'inherit',
        ],
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
    );
    // Keep the error listener through close. ENOENT is emitted asynchronously.
    let spawnError: Error | undefined;
    child.on('error', (error: Error) => {
      spawnError = error;
    });
    const stdin = child.stdin;
    const stdout = child.stdout;
    let closePromise: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      if (closePromise) {
        return closePromise;
      }
      opts.signal?.removeEventListener('abort', onAbort);
      // Destroy pipes now even if the launcher ignores TERM or a grandchild
      // holds stdout open. This also releases blocked readers and writers.
      stdin?.destroy();
      stdout?.destroy();
      closePromise = new Promise<void>((resolve) => {
        if (!child.pid) {
          resolve();
          return;
        }
        // Give cooperative agents time to exit, then kill the whole process
        // group, including descendants that inherited the stdio pipes.
        try {
          signalTree(child.pid, 'SIGTERM');
        } catch {
          /* force below */
        }
        const grace = setTimeout(() => {
          try {
            signalTree(child.pid, 'SIGKILL');
          } catch {
            /* bounded cleanup */
          }
          resolve();
        }, GRACE_MS);
        // Keep this timer referenced so close() cannot resolve by process exit
        // before descendant cleanup. The timeout bounds close even if ignored.
        void grace;
      });
      return closePromise;
    };
    const onAbort = () => {
      void stop();
    };
    if (!stdin || !stdout) {
      await stop();
      throw new AcpConnectError({
        agentId: spec.agentId,
        message: `ACP agent '${spec.agentId}' was spawned without usable stdio pipes.`,
      });
    }
    opts.signal?.addEventListener('abort', onAbort, {
      once: true,
    });
    const readable = frameworkCast<ReadableStream<Uint8Array>>(Readable.toWeb(stdout));
    const writable = frameworkCast<WritableStream<Uint8Array>>(Writable.toWeb(stdin));
    // Abort may race with listener installation after spawn.
    if (opts.signal?.aborted) {
      onAbort();
    }
    return {
      readable,
      writable,
      async close() {
        await stop();
        if (spawnError) {
          throw new AcpConnectError({
            agentId: spec.agentId,
            message: `ACP agent '${spec.agentId}' (${spec.command}) failed to start.`,
            cause: spawnError,
          });
        }
      },
    };
  };
}
