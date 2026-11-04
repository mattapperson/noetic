/**
 * Machines elsewhere, through a remote runner (`noetic-acp serve`), and the
 * runner itself.
 *
 * A runner on the agent's machine starts the agent with the preset's launch
 * settings, starts MCP servers beside it, and serves the host's tool bridge to
 * them on its own loopback interface — all over one channel, so the agent
 * needs no route back to the host. The channel is a WebSocket
 * ({@link webSocketMachine}) or the stdio of a command that starts the runner
 * there ({@link commandMachine}: `ssh host …`, `docker exec -i ctr …`).
 *
 * Node-only (`ws`, `node:child_process`), so it lives behind
 * `@noetic-tools/acp/remote`.
 */

import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { AcpMachineFactory } from '@noetic-tools/types';
import { AcpConnectError, frameworkCast } from '@noetic-tools/types';
import { WebSocket } from 'ws';
import { runnerMachine } from './runner/host';
import type { FrameLink } from './runner/protocol';
import { isLoopbackHost, lineFrameLink } from './runner/protocol';
import { webSocketFrameLink } from './runner/ws-link';

export type { AcpRunnerGrant } from './runner/grants';
export type { FrameLink, HostFrame, RunnerFrame } from './runner/protocol';
export { HostFrameSchema, lineFrameLink, RunnerFrameSchema } from './runner/protocol';
export type {
  AcpRunnerListener,
  AcpRunnerListenOptions,
  AcpRunnerOptions,
} from './runner/serve';
export { listenAcpRunner, serveAcpRunner, serveAcpRunnerOverStdio } from './runner/serve';
export { runnerMachine };

//#region Machines

/** @public Options for {@link webSocketMachine}. */
export interface WebSocketMachineOptions {
  /** The runner's `wss://` URL; `ws://` only to a loopback host. */
  url: string;
  /** The runner's bearer token. */
  token: string;
  /** PEM certificate authority to trust, for a runner with its own certificate. */
  ca?: string;
}

/**
 * A runner reached over WebSocket. Every upgrade carries the bearer token, and
 * a runner off the loopback interface is reached over TLS only.
 * @public
 */
export function webSocketMachine(opts: WebSocketMachineOptions): AcpMachineFactory {
  const url = new URL(opts.url);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && isLoopbackHost(url.hostname))) {
    throw new TypeError(
      `webSocketMachine needs a wss:// URL for ${url.host}; ws:// is allowed only to a loopback host.`,
    );
  }
  return runnerMachine(async () => {
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${opts.token}`,
      },
      ca: opts.ca,
      // Bun's built-in `ws` reads its TLS settings from here.
      ...{
        tls: {
          ca: opts.ca,
        },
      },
    });
    await new Promise<void>((resolve, reject) => {
      const refused = (detail: string, cause?: unknown): void => {
        reject(
          new AcpConnectError({
            agentId: 'runner',
            message: `The runner at ${url.host} refused the connection or could not be reached (${detail}).`,
            cause,
          }),
        );
      };
      socket.once('open', () => resolve());
      socket.once('unexpected-response', (_req, res) => refused(`HTTP ${res.statusCode}`));
      // Kept for the socket's life: a second error must not go unhandled.
      socket.on('error', (cause) => refused(cause.message, cause));
    });
    return webSocketFrameLink(socket);
  });
}

/** @public Options for {@link commandMachine}. */
export interface CommandMachineOptions {
  /** Starts a runner over stdio, e.g. `ssh`, or `docker` with `exec -i`. */
  command: string;
  /** e.g. `['build-host', 'npx', '-y', '@noetic-tools/acp', 'serve', '--stdio']`. */
  args: ReadonlyArray<string>;
  env?: Record<string, string | undefined>;
}

/**
 * A runner started by a local command and spoken to over its stdio. The
 * command's own channel (ssh, `docker exec`) carries the frames, so it adds no
 * listener anywhere.
 * @public
 */
export function commandMachine(opts: CommandMachineOptions): AcpMachineFactory {
  return runnerMachine(async (signal): Promise<FrameLink> => {
    const child = spawn(
      opts.command,
      [
        ...opts.args,
      ],
      {
        env: {
          ...process.env,
          ...opts.env,
        },
        stdio: [
          'pipe',
          'pipe',
          'inherit',
        ],
        signal,
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (cause) =>
        reject(
          new AcpConnectError({
            agentId: 'runner',
            message: `Could not start the runner with '${opts.command}'.`,
            cause,
          }),
        ),
      );
    });
    const { stdin, stdout } = child;
    if (!stdin || !stdout) {
      child.kill();
      throw new AcpConnectError({
        agentId: 'runner',
        message: `The runner started with '${opts.command}' has no stdio.`,
      });
    }
    stdin.on('error', () => undefined);
    return lineFrameLink(
      frameworkCast<ReadableStream<Uint8Array>>(Readable.toWeb(stdout)),
      frameworkCast<WritableStream<Uint8Array>>(Writable.toWeb(stdin)),
      async () => {
        child.kill();
      },
    );
  });
}

//#endregion
