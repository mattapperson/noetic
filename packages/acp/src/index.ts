/**
 * `@noetic-tools/acp` — an Agent Client Protocol client for Noetic.
 *
 * Drives any ACP-speaking coding agent as a step, and answers the protocol's
 * client-side responsibilities (`fs/*`, `terminal/*`,
 * `session/request_permission`) from Noetic's own adapters — with `fs/*` paths
 * confined to the session working directory by default, since ACP places
 * boundary enforcement on the client.
 *
 * The Node stdio transport lives at the `@noetic-tools/acp/stdio` subpath; this
 * entry point is runtime-neutral.
 *
 * Everything exported here is public API. Internal helpers — the item builders,
 * the turn accumulator, the terminal registry, the permission engine, the
 * capability and path assertions — are deliberately not re-exported: they are
 * implementation detail of the client and are free to change.
 */

//#region Agents

/** @public */
export type { AcpPresetOptions, AcpProcessSpec } from './agents';
/** @public */
export { claudeCode, codex, customAcpAgent, gemini, opencode, pi } from './agents';
/** @public */
export type { DefineAcpAgentOptions } from './define';
/** @public */
export { defineAcpAgent } from './define';
/** @public */
export type { AcpAgentRegistry } from './registry';
/** @public */
export { createAcpAgentRegistry } from './registry';

//#endregion

//#region Transports

/** @public */
export type { AcpLoopbackPair } from './transport-loopback';
/** @public */
export { createAcpLoopbackPair, loopbackTransport } from './transport-loopback';

//#endregion

//#region Human-in-the-loop permissions

/** @public */
export type {
  AcpPermissionPrompt,
  AcpPermissionReply,
  AskUserForPermissionOptions,
} from './permission-channel';
/** @public */
export {
  ACP_PERMISSION_SCOPE,
  AcpPermissionPromptSchema,
  AcpPermissionReplySchema,
  acpPermissionDecisions,
  acpPermissionRequests,
  askUserForPermission,
  resolveAcpPermission,
} from './permission-channel';

//#endregion

//#region Path confinement

/**
 * Exposed so a host writing a constraining `FsAdapter` can apply the same rules
 * the client does — including resolving symlinks, which the client's lexical
 * check deliberately does not do.
 * @public
 */
export { isAbsolutePath, isWithinRoots, normalizePath } from './paths';

//#endregion

//#region Server direction: serving a harness as an ACP agent

/** @public */
export type { ClientFsAdapterOptions, ClientShellAdapterOptions } from './client-adapters';
/**
 * Adapters backed by the ACP client's `fs/*` and `terminal/*` methods —
 * usually reached through `AcpServeSessionInit.client` in a per-session
 * harness factory rather than constructed by hand.
 * @public
 */
export { clientFsAdapter, clientShellAdapter } from './client-adapters';
/** @public */
export type { AcpServedAgent } from './serve';
/**
 * Adapt a harness into an ACP `Agent` factory — compose with
 * `loopbackTransport(toAcpAgent(harness))` for in-process serving, or bind it
 * to process stdio with `serveAcp` from `@noetic-tools/acp/server`.
 * @public
 */
export { toAcpAgent } from './serve';
/** @public */
export type { ServeTurnOutcome } from './serve-events';
/** @public */
export { evaluateServePolicy } from './serve-permissions';
/** @public */
export type {
  AcpPresentableTool,
  AcpServeCommand,
  AcpServeCommandContext,
  AcpServeHarness,
  AcpServeHarnessSource,
  AcpServeHistory,
  AcpServeOptions,
  AcpServePermissionDecision,
  AcpServePermissionPolicy,
  AcpServePermissionPrompt,
  AcpServePermissionReply,
  AcpServePermissionRule,
  AcpServeSessionInit,
} from './serve-types';

//#endregion

//#region Advanced: building a client by hand

/** @public */
export type { NoeticAcpClientOptions } from './client';
/** @public */
export { NoeticAcpClient } from './client';
/**
 * For embedding an ACP connection outside a Noetic step — a custom runtime, a
 * bridge, a test harness. `step.acpAgent` is the supported path; these are the
 * pieces underneath it.
 * @public
 */
export type { OpenAcpConnectionOptions } from './connection';
/** @public */
export { openAcpConnection } from './connection';

//#endregion
