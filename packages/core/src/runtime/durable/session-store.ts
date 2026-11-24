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
  /**
   * The lease term of the last turn that wrote this record (spec 23 § One writer per
   * turn). A turn holding a lower term was replaced, and its writes are refused.
   */
  term: z.number().int().nonnegative().optional(),
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
      /**
       * Set when the turn ended in a live process without finishing: it failed or was
       * cancelled. A turn with neither this nor `parked` was cut off by its process
       * dying. A routine wake resumes only the latter; delivering the turn's messages
       * again resumes either.
       */
      stopped: z
        .object({
          at: z.number(),
          reason: z.string(),
        })
        .optional(),
      /** The flow version the turn was last run under, when the harness names one. */
      version: z.string().optional(),
      /**
       * Set when the turn stopped rather than redo a step that had a lasting effect
       * under another flow version (spec 23 § Versions). It waits for the host.
       */
      stuck: z
        .object({
          path: z.string(),
          from: z.string(),
          to: z.string(),
        })
        .optional(),
      /** The host looked at the stuck turn and chose to go on: its next run may discard such steps. */
      /** The step a host chose to go on past (`true` in records written before that was kept). */
      accept: z
        .union([
          z.boolean(),
          z.string(),
        ])
        .optional(),
      /** Set while the turn is parked: every part of it waits, and no harness holds it. */
      parked: z
        .object({
          /** Epoch ms of the earliest deadline among its waits. Absent when none has one. */
          until: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  /**
   * The thread's most recent finished turns, oldest first: the messages each
   * delivered and the answer it gave. A message delivered again after its turn
   * finished is answered from here instead of run again.
   */
  done: z
    .array(
      z.object({
        messageIds: z.array(z.string()),
        text: z.string(),
        /** The turn's execution, under which its trail is kept. */
        executionId: z.string().optional(),
      }),
    )
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
          // Kept only across a park: a message that waits for the parked turn to end.
          'next-turn',
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

/** @internal A session record as read: the stored value, and the record it parses to. */
export interface StoredSession {
  /** Exactly what storage holds, or null when nothing is. */
  raw: unknown;
  /** Undefined when nothing is stored or it does not parse. */
  record: SessionRecord | undefined;
}

/** @internal Reads and writes session records under `session:<threadId>`. */
export interface SessionStore {
  /** The thread's record, or undefined when none is stored or it does not parse. */
  load(threadId: string): Promise<SessionRecord | undefined>;
  save(threadId: string, record: SessionRecord): Promise<void>;
  /** The record as stored, with the value it parsed from, for a compare-and-set. */
  read(threadId: string): Promise<StoredSession>;
  /**
   * Store `next` only if what is stored is still `prev` (a `read`'s `raw`).
   * Absent on storage that cannot compare-and-set.
   */
  swap?: (threadId: string, prev: unknown, next: SessionRecord) => Promise<boolean>;
  /** The ids of every thread with a stored record. */
  threads(): Promise<string[]>;
}

/** @internal */
export function createSessionStore(storage: StorageAdapter): SessionStore {
  const swap = storage.swap?.bind(storage);
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
    read: async (threadId) => {
      const raw = await storage.get<unknown>(sessionKey(threadId));
      const parsed = raw === null ? undefined : SessionRecordSchema.safeParse(raw);
      return {
        raw,
        record: parsed?.success ? parsed.data : undefined,
      };
    },
    ...(swap
      ? {
          swap: (threadId, prev, next) => swap(sessionKey(threadId), prev, next),
        }
      : {}),
    threads: async () =>
      (await storage.list(SESSION_PREFIX)).map((key) => key.slice(SESSION_PREFIX.length)),
  };
}

const SESSION_PREFIX = 'session:';

function sessionKey(threadId: string): string {
  return `${SESSION_PREFIX}${threadId}`;
}

//#endregion
