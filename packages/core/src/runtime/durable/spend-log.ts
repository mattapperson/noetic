/**
 * The spend log: one record per paid provider call, written before the call is sent
 * and deleted once its bill is known (spec 23 § Paid dispatches).
 *
 * Records live under `spend:<id>`, outside the `execution:<id>:` prefix, so clearing a
 * checkpoint or abandoning a turn never discards evidence that money was spent.
 */

import type { StorageAdapter } from '@noetic-tools/context';
import { storageGetMany } from '@noetic-tools/context';
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
 * A `spend:<id>` value that does not read as a record. Only the owner fields the
 * damaged value still names are kept; nothing else in it is trusted.
 */
export interface UnreadableRecord {
  readonly id: string;
  readonly unreadable: true;
  readonly executionId?: string;
  readonly threadId?: string;
}

/**
 * @internal
 * What a `spend:<id>` key holds: a record, or a value that does not read as one. An
 * unreadable value is still evidence that a paid call was sent, so it is kept and
 * reported rather than skipped.
 */
export type SpendRecord = DispatchRecord | UnreadableRecord;

/** @internal */
export function isUnreadable(record: SpendRecord): record is UnreadableRecord {
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
    get: async (id) => {
      const key = keyOf(id);
      const raw = await storage.get<unknown>(key);
      if (!isNothing(raw)) {
        return parse(id, raw);
      }
      return (await storage.list(key)).includes(key) ? unreadable(id) : undefined;
    },
    remove: async (id) => {
      await storage.delete(keyOf(id));
    },
    list: async () => {
      const keys = await storage.list(SPEND_PREFIX);
      const raws = await storageGetMany<unknown>(storage, keys);
      const damaged: UnreadableRecord[] = [];
      const records: DispatchRecord[] = [];
      for (const [key, raw] of raws) {
        if (isNothing(raw)) {
          continue;
        }
        const record = parse(key.slice(SPEND_PREFIX.length), raw);
        if (isUnreadable(record)) {
          damaged.push(record);
        } else {
          records.push(record);
        }
      }
      for (const key of await stillListed(keys.filter((key) => isNothing(raws.get(key))))) {
        damaged.push(unreadable(key.slice(SPEND_PREFIX.length)));
      }
      return [
        ...damaged,
        ...records.sort((a, b) => a.sentAt.localeCompare(b.sentAt)),
      ];
    },
  };

  /**
   * Of keys that listed but read as nothing, the ones that still list. A store may
   * read a value it cannot parse as nothing (`createFileStorage` does), and that value
   * is damaged, not gone; a key settled since it was listed no longer lists.
   */
  async function stillListed(missing: string[]): Promise<string[]> {
    if (missing.length === 0) {
      return [];
    }
    const listed = new Set(await storage.list(SPEND_PREFIX));
    return missing.filter((key) => listed.has(key));
  }
}

function keyOf(id: string): string {
  return `${SPEND_PREFIX}${id}`;
}

function isNothing(raw: unknown): raw is null | undefined {
  return raw === null || raw === undefined;
}

function parse(id: string, raw: unknown): SpendRecord {
  const parsed = DispatchRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : unreadable(id, owner(raw));
}

function unreadable(
  id: string,
  named: Pick<UnreadableRecord, 'executionId' | 'threadId'> = {},
): UnreadableRecord {
  return {
    id,
    unreadable: true,
    ...named,
  };
}

/**
 * The execution and thread a damaged record still names, so its write-off is charged
 * where its call ran. Any other field is not trusted.
 */
function owner(raw: unknown): Pick<UnreadableRecord, 'executionId' | 'threadId'> {
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
  executionId: z.string().min(1).optional().catch(undefined),
  threadId: z.string().min(1).optional().catch(undefined),
});

//#endregion
