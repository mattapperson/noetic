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
export function stdioAcpTransport(spec: StdioAgentSpec): AcpTransportFactory {
  return async (opts): Promise<AcpTransport> => {
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
      },
    );

    const stdin = child.stdin;
    const stdout = child.stdout;
    if (!stdin || !stdout) {
      child.kill();
      throw new AcpConnectError({
        agentId: spec.agentId,
        message: `ACP agent '${spec.agentId}' was spawned without usable stdio pipes.`,
      });
    }

    // A missing binary surfaces asynchronously on the child, long after spawn()
    // returned. Capture it so the failure is reported against the agent rather
    // than escaping as an unhandled 'error' event.
    let spawnError: Error | undefined;
    child.once('error', (error: Error) => {
      spawnError = error;
    });

    const onAbort = () => {
      child.kill();
    };
    opts.signal?.addEventListener('abort', onAbort, {
      once: true,
    });

    let closed = false;
    return {
      // `node:stream`'s web-stream types are structurally the same as the
      // global ones but nominally distinct, so the bridge is cast once here
      // rather than leaking a Node-specific type through the transport contract.
      readable: frameworkCast<ReadableStream<Uint8Array>>(Readable.toWeb(stdout)),
      writable: frameworkCast<WritableStream<Uint8Array>>(Writable.toWeb(stdin)),
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        opts.signal?.removeEventListener('abort', onAbort);
        child.kill();
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
