/**
 * The Node stdio entry for the server direction — the inverse of `./stdio`,
 * which spawns a child and binds to *its* stdio: `serveAcp` binds a served
 * harness to the **current process's** stdin/stdout, so an ACP client (Zed,
 * another editor, a Noetic step) that launched this process as its agent can
 * drive the harness.
 *
 * Lives behind the `@noetic-tools/acp/server` subpath so the package's main
 * entry stays runtime-neutral.
 *
 * ```ts
 * import { AgentHarness } from '@noetic-tools/core';
 * import { serveAcp } from '@noetic-tools/acp/server';
 *
 * const harness = new AgentHarness({ name: 'my-agent', agentGraph, tools, params: {} });
 * await serveAcp(harness).closed;
 * ```
 */

import { Readable, Writable } from 'node:stream';
import { frameworkCast } from '@noetic-tools/types';
import { AgentSideConnection, ndJsonStream } from '@zed-industries/agent-client-protocol';
import type { AcpServedAgent } from './serve';
import { toAcpAgent } from './serve';
import type { AcpServeHarnessSource, AcpServeOptions } from './serve-types';

/** @public Handle over a running stdio ACP server. */
export interface AcpServerHandle {
  /** Resolves when the client disconnects (stdin ends) or `close()` runs. */
  closed: Promise<void>;
  /** Cancel live sessions and stop serving. */
  close(): Promise<void>;
}

/**
 * Serve a harness as an ACP agent over the current process's stdio. `await`
 * the returned handle's `closed` to keep the process alive until the client
 * disconnects.
 * @public
 */
export function serveAcp(
  source: AcpServeHarnessSource,
  options: AcpServeOptions = {},
): AcpServerHandle {
  let agent: AcpServedAgent | undefined;
  // Constructing the connection registers its message pump on the streams; no
  // further reference is needed to keep it running — process.stdin holds the
  // event loop open until it ends or close() destroys it.
  new AgentSideConnection(
    (conn) => {
      agent = toAcpAgent(source, options)(conn);
      return agent;
    },
    ndJsonStream(
      frameworkCast<WritableStream<Uint8Array>>(Writable.toWeb(process.stdout)),
      frameworkCast<ReadableStream<Uint8Array>>(Readable.toWeb(process.stdin)),
    ),
  );

  let resolveClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closing = false;

  const close = async (): Promise<void> => {
    if (closing) {
      return closed;
    }
    closing = true;
    await agent?.dispose().catch(() => undefined);
    // Tear the transport down: ending stdin ends the connection's read loop,
    // so a close() while the client is still attached doesn't leave the
    // process parked on a live pipe.
    process.stdin.destroy();
    resolveClosed();
  };

  process.stdin.once('close', () => {
    void close();
  });
  process.stdin.once('end', () => {
    void close();
  });

  return {
    closed,
    close,
  };
}
