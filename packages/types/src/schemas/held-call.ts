/**
 * Held tool calls as the stream carries them (spec 08 § Held tool calls): the data of
 * `{name}:tool_call_held` and `{name}:tool_call_settled`, validated, so a host that
 * follows the stream never reads the event data by hand.
 */

import { z } from 'zod';
import type { HeldCall, HeldCallSettled } from '../types/harness-judgment';
import type { StreamEvent } from '../types/harness-result';

//#region Schemas

const HeldReasonSchema = z.enum([
  'approval',
  'result',
  'outcome',
  'question',
]);

/** A question put to a person (`HeldQuestion`). */
const HeldQuestionSchema = z.object({
  message: z.string(),
  schema: z.record(z.string(), z.unknown()).optional(),
  url: z.string().optional(),
});

/** @public The data of a `{name}:tool_call_held` event. */
export const HeldCallSchema = z.object({
  callId: z.string(),
  name: z.string(),
  args: z.unknown(),
  argsHash: z.string(),
  reason: HeldReasonSchema,
  dueAt: z.number().optional(),
  onDue: z
    .enum([
      'deny',
      'keep',
    ])
    .optional(),
  request: z.unknown().optional(),
  /** The question, on a call held with `reason: 'question'`. */
  question: HeldQuestionSchema.optional(),
  /** A coding agent's call: `callId` is the agent's id, and this the id a decision names. */
  heldAs: z.string().optional(),
});

/** @public The data of a `{name}:tool_call_settled` event. */
export const HeldCallSettledSchema = z.object({
  callId: z.string(),
  name: z.string(),
  argsHash: z.string(),
  reason: HeldReasonSchema,
  by: z.enum([
    'answer',
    'due',
    'skipped',
    'cancelled',
  ]),
  heldAs: z.string().optional(),
});

//#endregion

//#region Types

/** @public A held-call event, read: see `readHeldCallEvent`. */
export type HeldCallEvent =
  | {
      readonly type: 'held';
      readonly call: HeldCall;
    }
  | {
      readonly type: 'settled';
      readonly settled: HeldCallSettled;
    };

//#endregion

//#region Helpers

const HELD_SUFFIX = ':tool_call_held';
const SETTLED_SUFFIX = ':tool_call_settled';

function readHeld(data: unknown): HeldCallEvent | undefined {
  const parsed = HeldCallSchema.safeParse(data);
  if (!parsed.success) {
    return undefined;
  }
  const { heldAs, dueAt, onDue, request, ...call } = parsed.data;
  return {
    type: 'held',
    call: {
      ...call,
      // The id a decision names.
      callId: heldAs ?? call.callId,
      ...(dueAt === undefined
        ? {}
        : {
            dueAt,
          }),
      ...(onDue === undefined
        ? {}
        : {
            onDue,
          }),
      ...(request === undefined
        ? {}
        : {
            request,
          }),
    },
  };
}

function readSettled(data: unknown): HeldCallEvent | undefined {
  const parsed = HeldCallSettledSchema.safeParse(data);
  if (!parsed.success) {
    return undefined;
  }
  const { heldAs, ...settled } = parsed.data;
  return {
    type: 'settled',
    settled: {
      ...settled,
      callId: heldAs ?? settled.callId,
    },
  };
}

//#endregion

//#region Public API

/**
 * @public Read a stream event as a held-call event: `held` for `{name}:tool_call_held`,
 * `settled` for `{name}:tool_call_settled`, and `undefined` for any other event or for
 * data that does not fit. `callId` is always the id a decision names, also for a
 * coding agent's call, whose event carries the agent's own id beside it.
 *
 * @param agentName - Only events of this harness. Default: any harness.
 */
export function readHeldCallEvent(
  event: StreamEvent,
  agentName?: string,
): HeldCallEvent | undefined {
  if (event.source !== 'framework') {
    return undefined;
  }
  const prefix = agentName === undefined ? undefined : `${agentName}:`;
  if (prefix !== undefined && !event.type.startsWith(prefix)) {
    return undefined;
  }
  if (event.type.endsWith(HELD_SUFFIX)) {
    return readHeld(event.data);
  }
  if (event.type.endsWith(SETTLED_SUFFIX)) {
    return readSettled(event.data);
  }
  return undefined;
}

//#endregion
