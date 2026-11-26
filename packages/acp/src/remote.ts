/**
 * The remote runner (`noetic-acp serve`): started where an agent should run,
 * it starts the agent with the preset's launch settings, starts MCP servers
 * beside it, and serves the host's tool bridge to them on its own loopback
 * interface — all over one channel, so the agent needs no route back to the
 * host.
 *
 * A host reaches one through a subprocess adapter:
 * `createRunnerSubprocessAdapter()` from `@noetic-tools/core` over any frame
 * link, or the WebSocket and command adapters of the platform packages.
 *
 * Node-only (`ws`, `node:child_process`), so it lives behind
 * `@noetic-tools/acp/remote`.
 */

export type { AcpRunnerGrant } from './runner/grants';
export type {
  AcpRunnerListener,
  AcpRunnerListenOptions,
  AcpRunnerOptions,
} from './runner/serve';
export { listenAcpRunner, serveAcpRunner, serveAcpRunnerOverStdio } from './runner/serve';
