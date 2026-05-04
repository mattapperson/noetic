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
 * Feature loop-state changes — the autopilot's `wakeOn` trigger and a
 * fan-out feed for telemetry taps. Published by the validator flow (and
 * any other code path that mutates a feature's loop state). Topic mode
 * so multiple consumers see each transition with at-most-once delivery;
 * missed messages are recoverable from `_events.jsonl`.
 *
 * Self-publish from the autopilot's tick body is intentionally a no-op:
 * topic recv() only subscribes during `every`'s park phase, and a send
 * during the tick body has no concurrent subscribers, so the autopilot
 * cannot wake itself in a busy loop.
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
