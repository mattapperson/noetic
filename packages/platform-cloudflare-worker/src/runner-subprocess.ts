/**
 * Subprocess adapters for a Worker or Durable Object: a Worker cannot start a
 * process, so each runs its processes through a remote runner
 * (`noetic-acp serve`) over a WebSocket. Both are core's runner adapter over
 * a socket obtained here.
 */

import type { SubprocessAdapter, SubprocessOpen, WebSocketLike } from '@noetic-tools/core';
import {
  AcpConnectError,
  createRunnerSubprocessAdapter,
  isLoopbackHost,
  webSocketFrameLink,
} from '@noetic-tools/core';

//#region Types

/** The client socket a WebSocket upgrade answers with: usable once accepted. */
export interface UpgradedSocketLike extends WebSocketLike {
  accept(): void;
}

/** The part of `fetch` a WebSocket upgrade uses. A Worker's global `fetch` fits. */
export type UpgradeFetchLike = (
  url: string,
  init: {
    headers: Record<string, string>;
  },
) => Promise<{
  readonly status: number;
  readonly webSocket?: UpgradedSocketLike | null;
}>;

/** Options for {@link createFetchSubprocessAdapter}. */
export interface CreateFetchSubprocessAdapterOptions {
  /** The runner's `wss://` URL; `ws://` only to a loopback host. */
  url: string;
  /** The runner's bearer token. */
  token: string;
  /** Default: the global `fetch`. */
  fetch?: UpgradeFetchLike;
}

type RunnerSubprocessAdapter = SubprocessAdapter & {
  open: SubprocessOpen;
};

//#endregion

//#region Public API

/**
 * A runner that dialled in: its processes run where the far end of a
 * WebSocket this Durable Object accepted runs. `accepted` is called once per
 * link and returns an accepted (`socket.accept()`) socket no other link uses;
 * closing the link closes it. A socket accepted for hibernation
 * (`state.acceptWebSocket`) delivers its messages to the object's handlers,
 * not to listeners: build a `FrameLink` from those and give it to
 * `createRunnerSubprocessAdapter` instead.
 */
export function createSocketSubprocessAdapter(
  accepted: () => WebSocketLike | Promise<WebSocketLike>,
): RunnerSubprocessAdapter {
  return createRunnerSubprocessAdapter(async () => webSocketFrameLink(await accepted()));
}

/**
 * A runner this Worker dials: each link is one WebSocket, opened by a `fetch`
 * upgrade that carries the bearer token. A runner off the loopback interface
 * is reached over TLS only.
 *
 * @throws TypeError for a `ws://` URL to a host that is not loopback.
 */
export function createFetchSubprocessAdapter(
  options: CreateFetchSubprocessAdapterOptions,
): RunnerSubprocessAdapter {
  const url = new URL(options.url);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && isLoopbackHost(url.hostname))) {
    throw new TypeError(
      `createFetchSubprocessAdapter needs a wss:// URL for ${url.host}; ws:// is allowed only to a loopback host.`,
    );
  }
  // A Worker's fetch upgrades over the http(s) form of the address.
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return createRunnerSubprocessAdapter(async () => {
    const upgrade: UpgradeFetchLike = options.fetch ?? fetch;
    const refused = (detail: string, cause?: unknown): AcpConnectError =>
      new AcpConnectError({
        agentId: 'runner',
        message: `The runner at ${url.host} refused the connection or could not be reached (${detail}).`,
        cause,
      });
    const response = await upgrade(url.href, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${options.token}`,
      },
    }).catch((cause: unknown) => {
      throw refused(cause instanceof Error ? cause.message : String(cause), cause);
    });
    const socket = response.webSocket;
    if (!socket) {
      throw refused(`HTTP ${response.status}`);
    }
    socket.accept();
    return webSocketFrameLink(socket);
  });
}

//#endregion
