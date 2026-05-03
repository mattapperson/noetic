/**
 * Public exports for the LSP module. Plugin authors import
 * `LspServerContribution` and `LaunchSpec` from here to register additional
 * language servers via `NoeticPlugin.lspServers`.
 */

export { createBuiltinLspServers } from './builtin/index.js';
// `LspClient` (the class) is deliberately kept internal — plugin authors
// should depend on the `LspClientApi` interface so the concrete
// implementation can evolve without breaking them. The LspService owns
// instantiation.
export type { LspClientApi, LspClientOptions } from './client.js';
export { DiagnosticStore, mergeDiagnostics } from './diagnostics.js';
export type { ExtensionIndex } from './extension-index.js';
export { createExtensionIndex, resolveContributionForFile } from './extension-index.js';
export { LspInstallError, resolveLaunchCommand } from './install.js';
export {
  extractWordAtPosition,
  formatCallHierarchyPrepareResult,
  formatDefinitionResult,
  formatDocumentSymbolsResult,
  formatHover,
  formatIncomingCallsResult,
  formatOutgoingCallsResult,
  formatReferencesResult,
  formatWorkspaceSymbolsResult,
  LspOperation,
} from './operations.js';
export { findNearestRoot, findNearestRootSync } from './root-resolver.js';
export type { ClientFactoryArgs, ClientHandle, LspServiceOptions } from './service.js';
export { LspService } from './service.js';
export type {
  BunxLaunchSpec,
  GithubReleaseLaunchSpec,
  LaunchSpec,
  LaunchStrategy,
  LspServerContribution,
  PathLaunchSpec,
  ResolvedCommand,
} from './types.js';
