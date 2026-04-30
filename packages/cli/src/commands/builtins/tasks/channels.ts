/**
 * Typed channels carrying inter-step communication for the daemon flow.
 *
 * The daemon orchestration (autopilot, validator, health, reconcile) is one
 * `Step` graph rooted at `harness.detachedSpawn(taskDaemonFlow, ...)`. The
 * inner steps don't call each other directly — they communicate through the
 * channels declared here. Keeping all four declarations in one place makes
 * the message-bus surface easy to audit.
 */

import { channel } from '@noetic/core';
import { z } from 'zod';

import { FeatureLoopState } from './hierarchy/schemas.js';
import { EventSchema } from './schemas.js';

//#region Schemas

export const ValidatorRequestSchema = z.object({
  taskId: z.string(),
  featureId: z.string(),
});

export type ValidatorRequest = z.infer<typeof ValidatorRequestSchema>;

export const ValidatorOutcomeStatus = {
  Pass: 'pass',
  Fail: 'fail',
  Blocked: 'blocked',
} as const;

export type ValidatorOutcomeStatus =
  (typeof ValidatorOutcomeStatus)[keyof typeof ValidatorOutcomeStatus];

export const ValidatorOutcomeSchema = z.object({
  taskId: z.string(),
  featureId: z.string(),
  runId: z.string(),
  status: z.enum([
    ValidatorOutcomeStatus.Pass,
    ValidatorOutcomeStatus.Fail,
    ValidatorOutcomeStatus.Blocked,
  ]),
  result: z.record(z.string(), z.unknown()).nullable(),
});

export type ValidatorOutcome = z.infer<typeof ValidatorOutcomeSchema>;

const FeatureLoopStateSchema = z.enum([
  FeatureLoopState.Idle,
  FeatureLoopState.Implementing,
  FeatureLoopState.Validating,
  FeatureLoopState.Passed,
  FeatureLoopState.NeedsFix,
  FeatureLoopState.Blocked,
]);

export const FeatureLoopStateChangedMessageSchema = z.object({
  taskId: z.string(),
  featureId: z.string(),
  previousLoopState: FeatureLoopStateSchema,
  loopState: FeatureLoopStateSchema,
});

export type FeatureLoopStateChangedMessage = z.infer<typeof FeatureLoopStateChangedMessageSchema>;

//#endregion

//#region Channels

/**
 * Validator subscribes; autopilot signals when a feature transitions to
 * `Validating`. Queue mode + bounded capacity so requests aren't lost
 * under bursty load and the daemon can still apply back-pressure when
 * the validator is wedged.
 */
export const validatorRequestChan = channel('tasks.validator-request', {
  schema: ValidatorRequestSchema,
  mode: 'queue',
  capacity: 1024,
});

/**
 * Autopilot subscribes; the validator flow signals when a run terminates
 * (pass/fail/blocked). Same delivery semantics as `validatorRequestChan`.
 */
export const validatorOutcomeChan = channel('tasks.validator-outcome', {
  schema: ValidatorOutcomeSchema,
  mode: 'queue',
  capacity: 1024,
});

/**
 * Feature loop-state changes — the autopilot's `wakeOn` trigger and a
 * fan-out feed for telemetry taps. Topic mode so multiple consumers see
 * each transition with at-most-once delivery; missed messages are
 * recoverable from `_events.jsonl`.
 */
export const featureLoopStateChan = channel('tasks.feature-loop-state', {
  schema: FeatureLoopStateChangedMessageSchema,
  mode: 'topic',
});

/**
 * External — the agent-ci runner subprocess publishes here on exit so
 * the in-process daemon flow can react to runner outcomes without
 * polling `_events.jsonl`. The durable record stays on disk; the
 * channel is a low-latency cross-process tap on top of it.
 */
export const externalTaskEventsChan = channel('tasks.events', {
  schema: EventSchema,
  mode: 'queue',
  capacity: 4096,
  external: true,
});

//#endregion
