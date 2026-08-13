/**
 * `@noetic-tools/acp` — an Agent Client Protocol client for Noetic.
 *
 * Drives any ACP-speaking coding agent as a step, and answers the protocol's
 * client-side responsibilities (`fs/*`, `terminal/*`, `session/request_permission`)
 * from Noetic's own adapters, so a sub-agent's file and shell access is subject
 * to the same sandboxing and audit as first-party steps.
 *
 * The Node stdio transport lives at the `@noetic-tools/acp/stdio` subpath; this
 * entry point is runtime-neutral.
 */

export type { AcpPresetOptions, AcpProcessSpec } from './agents';
export { claudeCode, codex, customAcpAgent, gemini } from './agents';
export type { NoeticAcpClientOptions } from './client';
export { clientCapabilitiesFor, NoeticAcpClient, sliceLines } from './client';
export type { OpenAcpConnectionOptions } from './connection';
export { assertPromptContentSupported, openAcpConnection } from './connection';
export type { DefineAcpAgentOptions } from './define';
export { defineAcpAgent } from './define';
export {
  asItems,
  assistantMessageItem,
  contentBlockText,
  functionCallItem,
  functionCallOutputItem,
} from './items';
export type {
  AcpPermissionPrompt,
  AcpPermissionReply,
  AskUserForPermissionOptions,
} from './permission-channel';
export {
  ACP_PERMISSION_SCOPE,
  AcpPermissionPromptSchema,
  AcpPermissionReplySchema,
  acpPermissionDecisions,
  acpPermissionRequests,
  askUserForPermission,
  resolveAcpPermission,
} from './permission-channel';
export type {
  AcpPermissionResolverOptions,
  AcpRequestPermissionOutcome,
} from './permissions';
export {
  evaluatePolicy,
  resolvePermission,
  ruleMatches,
  selectPermissionOption,
} from './permissions';
export type { AcpAgentRegistry } from './registry';
export { createAcpAgentRegistry } from './registry';
export type {
  AcpEnvVariable,
  AcpTerminalExitStatus,
  CreateTerminalOptions,
  TerminalOutputSnapshot,
} from './terminals';
export { buildCommandLine, quoteShellArg, TerminalRegistry } from './terminals';
export type { AcpLoopbackPair } from './transport-loopback';
export { createAcpLoopbackPair, loopbackTransport } from './transport-loopback';
export { AcpTurnAccumulator, renderToolCallContent } from './turn';
