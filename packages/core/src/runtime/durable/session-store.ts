/**
 * What a session (`harness.execute()`) keeps in storage so a new harness can pick a
 * thread up: the thread's history, what its turns spent, and the turn in flight.
 *
 * A turn's record is written before the turn runs and cleared when it finishes. A
 * harness that finds one still set knows the turn was cut off. If the same messages
 * arrive again — a host with at-least-once delivery re-sends what it never saw
 * answered — the turn resumes on its recorded execution: finished steps replay and
 * the turn continues from the step that was cut off.
 *
 * Steers sent into a running turn are kept too, until the turn ends, so a turn that
 * resumes on a new harness still applies the steers it had not applied yet.
 */

import type { StorageAdapter } from '@noetic-tools/context';
import { z } from 'zod';

//#region Schema

const SessionRecordSchema = z.object({
  /** The thread's history after its last finished turn. */
  items: z.array(z.unknown()),
  /** What the thread's turns have spent, summed as each turn settles. */
  usage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cachedTokens: z.number().optional(),
      cost: z.number().optional(),
      billedCost: z.number().optional(),
    })
    .optional(),
  /** The turn in flight, if one was cut off. */
  turn: z
    .object({
      executionId: z.string(),
      /** The ids of the messages the turn delivers, in order. */
      messageIds: z.array(z.string()),
      /** Set while the turn is parked: every part of it waits, and no harness holds it. */
      parked: z
        .object({
          /** Epoch ms of the earliest deadline among its waits. */
          until: z.number(),
        })
        .optional(),
    })
    .optional(),
  /** Steers sent into the turn in flight, in arrival order. */
  steers: z
    .array(
      z.object({
        id: z.string(),
        /** The `execute()` input: a string, an item, or items. */
        input: z.unknown(),
        deliveryMode: z.enum([
          'between-rounds',
          'next-item',
        ]),
        enqueuedAt: z.number(),
      }),
    )
    .optional(),
});

/** @internal One thread's stored session. */
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

//#endregion

//#region Store

/** @internal Reads and writes session records under `session:<threadId>`. */
export interface SessionStore {
  /** The thread's record, or undefined when none is stored or it does not parse. */
  load(threadId: string): Promise<SessionRecord | undefined>;
  save(threadId: string, record: SessionRecord): Promise<void>;
  /** The ids of every thread with a stored record. */
  threads(): Promise<string[]>;
}

/** @internal */
export function createSessionStore(storage: StorageAdapter): SessionStore {
  return {
    load: async (threadId) => {
      const raw = await storage.get<unknown>(sessionKey(threadId));
      if (raw === null) {
        return undefined;
      }
      const parsed = SessionRecordSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn(
          `SessionStore: discarding unreadable session "${threadId}": ${parsed.error.message}`,
        );
        return undefined;
      }
      return parsed.data;
    },
    save: async (threadId, record) => {
      await storage.set(sessionKey(threadId), record);
    },
    threads: async () =>
      (await storage.list(SESSION_PREFIX))
        .filter((key) => !key.endsWith(LEASE_SUFFIX))
        .map((key) => key.slice(SESSION_PREFIX.length)),
  };
}

const SESSION_PREFIX = 'session:';
/** The suffix of a thread's lease record, which shares the prefix (see `turn-lease`). */
const LEASE_SUFFIX = ':lease';

function sessionKey(threadId: string): string {
  return `${SESSION_PREFIX}${threadId}`;
}

//#endregion
