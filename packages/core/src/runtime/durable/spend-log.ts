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

//#endregion

//#region Store

/** @internal */
export interface SpendLog {
  put(record: DispatchRecord): Promise<void>;
  get(id: string): Promise<DispatchRecord | undefined>;
  remove(id: string): Promise<void>;
  /** Every record, oldest first. Unreadable rows are skipped. */
  list(): Promise<DispatchRecord[]>;
}

/** @internal */
export function createSpendLog(storage: StorageAdapter): SpendLog {
  return {
    put: async (record) => {
      await storage.set(keyOf(record.id), record);
    },
    get: async (id) => parse(await storage.get<unknown>(keyOf(id))),
    remove: async (id) => {
      await storage.delete(keyOf(id));
    },
    list: async () => {
      const keys = await storage.list(SPEND_PREFIX);
      const raws = await storageGetMany<unknown>(storage, keys);
      const records: DispatchRecord[] = [];
      for (const [key, raw] of raws) {
        const record = parse(raw);
        if (!record) {
          console.warn(`SpendLog: skipping unreadable dispatch record "${key}"`);
          continue;
        }
        records.push(record);
      }
      return records.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    },
  };
}

function keyOf(id: string): string {
  return `${SPEND_PREFIX}${id}`;
}

function parse(raw: unknown): DispatchRecord | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const parsed = DispatchRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

//#endregion
