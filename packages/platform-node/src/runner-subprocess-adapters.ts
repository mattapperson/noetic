/**
 * Subprocess adapters whose processes run through a remote runner
 * (`noetic-acp serve`): one dialled over WebSocket, one started by a local
 * command and spoken to over its stdio (`ssh host …`, `docker exec -i ctr …`).
 * Both are core's runner adapter over a link opened here.
 */

import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { FrameLink, SubprocessAdapter, SubprocessOpen } from '@noetic-tools/core';
import {
  AcpConnectError,
  createRunnerSubprocessAdapter,
  isLoopbackHost,
  lineFrameLink,
  webSocketFrameLink,
} from '@noetic-tools/core';
import { frameworkCast } from '@noetic-tools/core/unstable';
import { WebSocket } from 'ws';

//#region Types

/** Options for {@link createWebSocketSubprocessAdapter}. */
export interface CreateWebSocketSubprocessAdapterOptions {
  /** The runner's `wss://` URL; `ws://` only to a loopback host. */
  url: string;
  /** The runner's bearer token. */
  token: string;
  /** PEM certificate authority to trust, for a runner with its own certificate. */
  ca?: string;
}

/** Options for {@link createCommandSubprocessAdapter}. */
export interface CreateCommandSubprocessAdapterOptions {
  /** Starts a runner over stdio, e.g. `ssh`, or `docker` with `exec -i`. */
  command: string;
  /** e.g. `['build-host', 'npx', '-y', '@noetic-tools/acp', 'serve', '--stdio']`. */
  args: ReadonlyArray<string>;
  env?: Record<string, string | undefined>;
}

type RunnerSubprocessAdapter = SubprocessAdapter & {
  open: SubprocessOpen;
};

//#endregion

//#region Public API

/**
 * A runner reached over WebSocket. Every upgrade carries the bearer token, and
 * a runner off the loopback interface is reached over TLS only.
 *
 * @throws TypeError for a `ws://` URL to a host that is not loopback.
 */
export function createWebSocketSubprocessAdapter(
  options: CreateWebSocketSubprocessAdapterOptions,
): RunnerSubprocessAdapter {
  const url = new URL(options.url);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && isLoopbackHost(url.hostname))) {
    throw new TypeError(
      `createWebSocketSubprocessAdapter needs a wss:// URL for ${url.host}; ws:// is allowed only to a loopback host.`,
    );
  }
  return createRunnerSubprocessAdapter(async () => {
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${options.token}`,
      },
      ca: options.ca,
      // Bun's built-in `ws` reads its TLS settings from here.
      ...{
        tls: {
          ca: options.ca,
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

/**
 * A runner started by a local command and spoken to over its stdio. The
 * command's own channel (ssh, `docker exec`) carries the frames, so it adds no
 * listener anywhere.
 */
export function createCommandSubprocessAdapter(
  options: CreateCommandSubprocessAdapterOptions,
): RunnerSubprocessAdapter {
  return createRunnerSubprocessAdapter(async (signal): Promise<FrameLink> => {
    const child = spawn(
      options.command,
      [
        ...options.args,
      ],
      {
        env: {
          ...process.env,
          ...options.env,
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
            message: `Could not start the runner with '${options.command}'.`,
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
        message: `The runner started with '${options.command}' has no stdio.`,
      });
    }
    stdin.on('error', () => undefined);
    return lineFrameLink(
      // `node:stream`'s web streams are the global ones in all but name.
      frameworkCast<ReadableStream<Uint8Array>>(Readable.toWeb(stdout)),
      frameworkCast<WritableStream<Uint8Array>>(Writable.toWeb(stdin)),
      async () => {
        child.kill();
      },
    );
  });
}

//#endregion
