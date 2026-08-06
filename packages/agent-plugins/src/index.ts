/**
 * `@noetic-tools/agent-plugins` — an Agent Plugins v1 client for Noetic.
 *
 * Implements the specification published at https://agent-plugins.org
 * (v1.0.0): plugin manifest validation, the two portable component types
 * (Agent Skills and MCP servers), path containment, plugin variable expansion,
 * and the `tools.noetic` client-extension namespace.
 *
 * The deliverable is {@link agentPlugins}, a context layer that presents
 * discovered plugins to a model using the spec's progressive disclosure model.
 */

export type {
  DiagnosticCode,
  PluginDiagnostic,
} from './diagnostics';
export { DiagnosticCode as PluginDiagnosticCode, diagnostic } from './diagnostics';
export type {
  DiscoveredMcpServer,
  DiscoveredSkill,
  DiscoveryResult,
  LoadedPlugin,
  LoadPluginResult,
} from './discovery';
export { discoverPlugins, loadPlugin } from './discovery';
export type {
  AgentPluginsConfig,
  AgentPluginsLayer,
  AgentPluginsState,
} from './layer/agent-plugins';
export { AGENT_PLUGINS_LAYER_ID, agentPlugins } from './layer/agent-plugins';
export type {
  ManifestResult,
  PluginManifest,
} from './manifest';
export {
  AuthorSchema,
  NOETIC_EXTENSION_NAMESPACE,
  PLUGIN_SCHEMA_ID,
  PluginManifestSchema,
  readExtension,
  SPEC_VERSION,
  validateManifest,
} from './manifest';
export type {
  McpConnectResult,
  McpSession,
  McpToolInfo,
} from './mcp-client';
export { buildSubprocessEnv, callMcpTool, closeSessions, connectMcpServer } from './mcp-client';
export type {
  McpDocument,
  McpDocumentResult,
  McpEntryResult,
  McpResolveResult,
  McpServerConfig,
  McpTransport,
  PluginVariables,
  ResolvedHttpServer,
  ResolvedMcpServer,
  ResolvedStdioServer,
} from './mcp-config';
export {
  DEFAULT_TRANSPORTS,
  expandPlaceholders,
  MCP_SCHEMA_ID,
  McpDocumentSchema,
  McpServerSchema,
  McpTransport as McpTransportKind,
  parseMcpDocument,
  resolveMcpServer,
  validateMcpEntry,
} from './mcp-config';
export type { ContainmentResult } from './paths';
export { containedPath, isPluginRelativePath, resolvePluginRelative, resolveRoot } from './paths';
export type {
  ParsedSkill,
  SkillFrontmatter,
  SkillParseResult,
} from './skill';
export { parseAllowedTools, parseSkill, SkillFrontmatterSchema } from './skill';
