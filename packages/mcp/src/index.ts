/**
 * @noetic-tools/mcp — the MCP bridge (spec 35): `mcp()` turns any MCP server
 * into a connection, with profile negotiation (spec 36), the Tasks extension
 * (SEP-2663), the Events extension (SEP-3415) and webhook verification. The
 * only package permitted to import the MCP SDK.
 */

export { PROFILES_CAPABILITY } from '@noetic-tools/types';
export type {
  McpConfig,
  McpFetch,
  McpHttpServer,
  McpOptions,
  McpServerTarget,
  McpStdioServer,
  McpTransportServer,
  ResolvedMcpConfig,
} from './config';
export {
  DEFAULT_MCP_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  resolveMcpConfig,
  splitCommandLine,
} from './config';
export type { McpConnectionInit } from './connection';
export { McpConnection } from './connection';
export type {
  Catalog,
  Discovery,
  DiscoveryOutcome,
  OperationRoute,
  ServedParts,
} from './declaration';
export { discover, overForgivingDeterminism, overTrustedSenses } from './declaration';
export { connectionError, requestErrorPayload, toolErrorPayload } from './errors';
export { deliveryModes } from './events';
export { coverageUri, parseAnomalies, parseCoverage } from './evidence';
export { createMemoryArtifactStore } from './memory-artifacts';
export { McpProvider, mcp } from './provider';
export { originAwareFetch } from './transports';
export type {
  McpWebhooks,
  SeenIds,
  WebhookDelivery,
  WebhookReceiver,
  WebhookRegistration,
  WebhookRejection,
  WebhookReply,
  WebhookVerification,
} from './webhooks';
export {
  generateWebhookSecret,
  signWebhook,
  verifyWebhook,
  WEBHOOK_TOLERANCE_SEC,
} from './webhooks';
export type { EventDelivery } from './wire';
export {
  COVERAGE_URI,
  EVENTS_EXTENSION,
  IDENTITY_CHANGED_EVENT,
  IDENTITY_URI,
  McpMethod,
  McpNotification,
  TASKS_EXTENSION,
  UniversalTool,
} from './wire';
