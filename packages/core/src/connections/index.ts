/**
 * The connection runtime (spec 35): registry, gates, refs, blobs, secrets,
 * pools, events, triggers, sources, model tools and views.
 */

export { attachBlobs, checkBlobs, findBlobs } from './blobs';
export type { CronSchedule } from './cron-schedule';
export { cronMatches, nextCronRun, parseCronSchedule } from './cron-schedule';
export type { PendingConnectionEntry, ResumeDecision } from './durability';
export {
  resumeDecision,
  sameInstance,
  stepIdempotencyKey,
  toolIdempotencyKey,
} from './durability';
export { bufferedEventStream } from './event-stream';
export type { GateContext, GateHooks, GateRequest } from './gates';
export { admitIncoming, gatedCall } from './gates';
export { matchesAnyGlob, matchesGlob } from './glob';
export { CONNECTION_NAME_PATTERN, connection, handleTarget, isConnectionHandle } from './handle';
export type {
  InMemoryCallContext,
  InMemoryCallRecord,
  InMemoryConnection,
  InMemoryConnectionOptions,
  InMemoryConnectionProvider,
  InMemoryEventType,
  InMemoryOperation,
  InMemoryResource,
  InMemoryTaskStep,
} from './in-memory-connection';
export { createInMemoryConnection, InMemoryRefusal, inMemoryRefusal } from './in-memory-connection';
export { secretAllowedAt, validateJsonSchema } from './json-schema';
export type { ConnectionToolsOptions } from './model-tools';
export {
  buildConnectionTools,
  connectionToolName,
  connectionTools,
  runtimeOf,
} from './model-tools';
export type { ConnectionUse } from './negotiation';
export { checkRequirement, requirementFor } from './negotiation';
export { evaluatePolicy } from './policy';
export { ConnectionPool, DEFAULT_POOL_WAIT_MS } from './pool';
export type { RefKindInfo, RefScope } from './refs';
export { kindInfoFrom, RefSealer, refConnections, refKindsOf } from './refs';
export type {
  ConnectionFrameworkEventRecord,
  ConnectionRuntime,
  ConnectionRuntimeOptions,
  RuntimeResolveRequest,
} from './registry';
export { createConnectionRuntime } from './registry';
export type {
  ConnectionCaller,
  ConnectionRegistry,
  ConnectionScope,
  GatedCallOptions,
  ResolvedConnection,
  ResolveRequest,
} from './registry-types';
export { checkSecrets, fillSecrets, findSecrets, SecretScrubber } from './secrets';
export { cron, defineSource } from './sources';
export type { TriggerDelivery, TriggerRunnerOptions } from './triggers';
export { TriggerRunner, validateTriggers } from './triggers';
export type { ConnectionViewState } from './views';
export { connectionViewLayer, connectionViewLayers, lineDiff } from './views';
