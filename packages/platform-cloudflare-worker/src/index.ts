/**
 * `@noetic-tools/platform-cloudflare-worker` — Noetic on Cloudflare Workers.
 *
 * Durable storage with `swap` over D1 and over a Durable Object's SQLite, with a
 * scope per tenant and a blob store for values too large for a row, an HTTP
 * endpoint that turns an accepted request into a stored event, two ways to wake
 * parked turns (a Durable Object alarm, or one Cloudflare Workflow instance per
 * turn), and Cron Trigger ticks as scans or as turns of a Durable Object's harness.
 *
 * Nothing here imports `cloudflare:workers` or a Cloudflare types package: each
 * helper takes the small part of a binding it uses, so the same code runs under
 * `workerd`, Miniflare and a plain test.
 */

export {
  type AlarmSchedule,
  type AlarmStorageLike,
  type AlarmWake,
  type AlarmWakeOptions,
  alarmWake,
  type DurableObjectStateLike,
  durableObjectHolder,
  type SharedAlarm,
  type SharedAlarmStorageLike,
  sharedAlarm,
  type WakeableHarness,
} from './alarm-wake';
export {
  type CronTick,
  type CronTurnOptions,
  type CronWakeOptions,
  cronTurn,
  cronWake,
} from './cron-wake';
export {
  type CreateD1StorageOptions,
  createD1Storage,
  type D1DatabaseLike,
  type D1StatementLike,
} from './d1-storage';
export {
  type CreateDurableObjectStorageOptions,
  createDurableObjectStorage,
  type DurableObjectLike,
  type DurableObjectSqlLike,
  durableObjectEnvironment,
} from './durable-object-storage';
export { type EventEndpointOptions, EventEndpointStatus, eventEndpoint } from './event-endpoint';
export {
  type BlobStoreLike,
  DEFAULT_SPILL_BYTES,
  type SpillOptions,
  spillStorage,
} from './spill-storage';
export {
  type StandardWebhookVerifierOptions,
  standardWebhookVerifier,
  WEBHOOK_TOLERANCE_MS,
} from './standard-webhook';
export {
  DEFAULT_MAX_WAIT_MS,
  type RunTurnOptions,
  runTurn,
  startTurn,
  TURN_WAKE_EVENT,
  type TurnHarness,
  type TurnOutcome,
  type TurnParams,
  turnInstanceId,
  type WorkflowBindingLike,
  type WorkflowInstanceLike,
  type WorkflowStepLike,
  wakeTurn,
} from './workflow-turn';
