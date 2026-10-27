/**
 * The spend log: one record per paid provider call, written before the call is sent
 * and deleted once its bill is known (spec 23 § Paid dispatches).
 *
 * Records live under `spend:<id>`, outside the `execution:<id>:` prefix, so clearing a
 * checkpoint or abandoning a turn never discards evidence that money was spent.
 */

import type { StorageAdapter } from '@noetic-tools/context';
import { storageGetMany } from '@noetic-tools/context';
import type { UnreadableDispatch } from '@noetic-tools/types';
import { z } from 'zod';

//#region Schema

const SPEND_PREFIX = 'spend:';

/** @internal A dispatch record as stored. */
export const DispatchRecordSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    'model',
    'decide',
  ]),
  model: z.string(),
  requestHash: z.string(),
  inputTokens: z.number(),
  maxOutputTokens: z.number().optional(),
  executionId: z.string().optional(),
  threadId: z.string().optional(),
  path: z.string().optional(),
  generationId: z.string().optional(),
  sentAt: z.string(),
});

/** @internal */
export type DispatchRecord = z.infer<typeof DispatchRecordSchema>;

/**
 * @internal
 * What a `spend:<id>` key holds: a record, or a value that does not read as one. An
 * unreadable value is still evidence that a paid call was sent, so it is kept and
 * reported rather than skipped.
 */
export type SpendRecord = DispatchRecord | UnreadableDispatch;

/** @internal */
export function isUnreadable(record: SpendRecord): record is UnreadableDispatch {
  return 'unreadable' in record;
}

//#endregion

//#region Store

/** @internal */
export interface SpendLog {
  put(record: DispatchRecord): Promise<void>;
  get(id: string): Promise<SpendRecord | undefined>;
  remove(id: string): Promise<void>;
  /** Every record: unreadable ones first, since their age is unknown, then oldest first. */
  list(): Promise<SpendRecord[]>;
}

/** @internal */
export function createSpendLog(storage: StorageAdapter): SpendLog {
  return {
    put: async (record) => {
      await storage.set(keyOf(record.id), record);
    },
    get: async (id) => parse(id, await storage.get<unknown>(keyOf(id))),
    remove: async (id) => {
      await storage.delete(keyOf(id));
    },
    list: async () => {
      const keys = await storage.list(SPEND_PREFIX);
      const raws = await storageGetMany<unknown>(storage, keys);
      const unreadable: UnreadableDispatch[] = [];
      const records: DispatchRecord[] = [];
      for (const [key, raw] of raws) {
        const record = parse(key.slice(SPEND_PREFIX.length), raw);
        if (!record) {
          continue;
        }
        if (isUnreadable(record)) {
          unreadable.push(record);
        } else {
          records.push(record);
        }
      }
      return [
        ...unreadable,
        ...records.sort((a, b) => a.sentAt.localeCompare(b.sentAt)),
      ];
    },
  };
}

function keyOf(id: string): string {
  return `${SPEND_PREFIX}${id}`;
}

/** Undefined only when the key holds nothing. */
function parse(id: string, raw: unknown): SpendRecord | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const parsed = DispatchRecordSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  return {
    id,
    unreadable: true,
    ...owner(raw),
  };
}

/**
 * The execution and thread a damaged record still names, so its write-off is charged
 * where its call ran. Any other field is not trusted.
 */
function owner(raw: unknown): Pick<UnreadableDispatch, 'executionId' | 'threadId'> {
  const parsed = OwnerSchema.safeParse(raw);
  if (!parsed.success) {
    return {};
  }
  const { executionId, threadId } = parsed.data;
  return {
    ...(executionId !== undefined
      ? {
          executionId,
        }
      : {}),
    ...(threadId !== undefined
      ? {
          threadId,
        }
      : {}),
  };
}

const OwnerSchema = z.object({
  executionId: z.string().optional().catch(undefined),
  threadId: z.string().optional().catch(undefined),
});

//#endregion
