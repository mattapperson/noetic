/**
 * What a trigger keeps about each event (spec 35 § Triggers): the inbox entry
 * that holds an event until its turn has finished, the receipt left once it
 * has, and the outcome a host reads back from either.
 */

import { z } from 'zod';
import { isPlainRecord } from './values';

//#region Types

/** @public The last recorded outcome of a trigger event. */
export type TriggerOutcome = {
  readonly eventId: string;
  readonly messageId?: string;
  readonly threadId?: string;
} & (
  | {
      readonly status: 'pending' | 'delivered';
    }
  | {
      readonly status: 'failed';
      readonly attempts?: number;
      readonly error: string;
    }
);

//#endregion

//#region Schemas

const FailureSchema = z.object({
  status: z.literal('failed'),
  attempts: z.number(),
  error: z.string(),
});

const ReceiptSchema = z.object({
  status: z.literal('delivered'),
  messageId: z.string().optional(),
  threadId: z.string().optional(),
});

/** An event a trigger has taken and not yet finished: what its turn starts with. */
export const InboxEntrySchema = z.object({
  event: z.object({
    id: z.string(),
    type: z.string(),
    time: z.string(),
    payload: z.unknown(),
    cursor: z.string().nullable(),
    connection: z.string(),
    actionId: z.string().optional(),
  }),
  threadId: z.string(),
  input: z.string(),
  messageId: z.string(),
  /** Set once every delivery attempt has failed; the entry then waits for a replay. */
  failure: FailureSchema.optional(),
});

export type InboxEntry = z.infer<typeof InboxEntrySchema>;

//#endregion

//#region Public API

/** The outcome an inbox value shows: `pending`, or `failed` once its turns gave up. */
export function inboxOutcome(eventId: string, value: unknown): TriggerOutcome | undefined {
  const entry = InboxEntrySchema.safeParse(value);
  if (!entry.success) {
    return undefined;
  }
  const { messageId, threadId, failure } = entry.data;
  return failure
    ? {
        eventId,
        messageId,
        threadId,
        ...failure,
      }
    : {
        eventId,
        messageId,
        threadId,
        status: 'pending',
      };
}

/**
 * The outcome a receipt shows. A receipt is `{ status: 'delivered', … }`, a
 * bare `true` (delivered, with no ids kept), or `{ failed }` for an event
 * that never became a turn.
 */
export function seenOutcome(eventId: string, value: unknown): TriggerOutcome | undefined {
  const receipt = ReceiptSchema.safeParse(value);
  if (receipt.success) {
    return {
      eventId,
      ...receipt.data,
    };
  }
  if (value === true) {
    return {
      eventId,
      status: 'delivered',
    };
  }
  if (isPlainRecord(value) && typeof value.failed === 'string') {
    return {
      eventId,
      status: 'failed',
      error: value.failed,
    };
  }
  return undefined;
}

//#endregion
