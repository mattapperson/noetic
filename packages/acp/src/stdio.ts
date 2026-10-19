/** Node-only ACP transport; the main entry never imports child_process. */
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { AcpTransport, AcpTransportFactory } from '@noetic-tools/types';
import { AcpConnectError, frameworkCast } from '@noetic-tools/types';
import { stopProcess } from './stdio-process';

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
 * Spawn an ACP agent with inherited stderr. Closing or aborting closes the pipes
 * and stops its process group (Windows: process tree), with bounded escalation.
 * Descendants that detach into their own session must manage their own lifetime.
 * @public
 */
export function stdioAcpTransport(spec: StdioAgentSpec): AcpTransportFactory {
  return async (opts): Promise<AcpTransport> => {
    const fail = (cause: unknown): AcpConnectError =>
      new AcpConnectError({
        agentId: spec.agentId,
        message: `ACP agent '${spec.agentId}' (${spec.command}) could not start or stop.`,
        cause,
      });
    if (opts.signal?.aborted) {
      throw fail(opts.signal.reason);
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
        // Wrappers often launch the real agent as a grandchild. Give those children
        // their own group so shutdown cannot signal the host's process group.
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
    );
    const pid = child.pid;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= stopProcess(child, pid).catch((error) => {
        throw fail(error);
      });
      opts.signal?.removeEventListener('abort', onAbort);
      return closing;
    };
    // Observe failures here; an explicit close still receives the same failure.
    const onAbort = (): void => {
      void close().catch(() => undefined);
    };
    opts.signal?.addEventListener('abort', onAbort, {
      once: true,
    });
    if (opts.signal?.aborted) {
      onAbort();
    }
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      if (opts.signal?.aborted) {
        throw opts.signal.reason;
      }
    } catch (error) {
      await close();
      throw fail(error);
    }
    return {
      // Node's web-stream types are nominally distinct from the global types.
      readable: frameworkCast<ReadableStream<Uint8Array>>(Readable.toWeb(child.stdout)),
      writable: frameworkCast<WritableStream<Uint8Array>>(Writable.toWeb(child.stdin)),
      close,
    };
  };
}
