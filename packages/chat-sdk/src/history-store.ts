import type { Item } from '@noetic-tools/types';
import { ItemSchema } from '@noetic-tools/types';
import { z } from 'zod';

/**
 * Two-method KV seam a chat-sdk state adapter (Redis, Postgres, Memory) can
 * satisfy, so history rides the same store that already backs thread
 * subscriptions and locking.
 */
export interface ChatStateLike {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<unknown>;
}

/**
 * Thread history persistence for `noeticAgent`. Mirrors platform-node's
 * `ChatHistoryStore` contract (read in append order; append atomic within a
 * process) and adds the seeded marker so first-contact detection survives
 * restarts and multiple workers.
 */
export interface NoeticChatHistoryStore {
  readChatHistory(threadId: string): Promise<Item[]>;
  appendChatItem(threadId: string, item: Item): Promise<void>;
  isSeeded(threadId: string): Promise<boolean>;
  markSeeded(threadId: string): Promise<void>;
}

const HISTORY_PREFIX = 'noetic:history:';
const SEEDED_PREFIX = 'noetic:seeded:';

const StoredItemsSchema = z.array(ItemSchema);

/**
 * History store over a KV seam. Append is read-modify-write: atomic within a
 * process, and safe across workers because chat-sdk's distributed locking
 * serializes handlers per thread. Corrupt stored state reads as an empty
 * history (with a warning) rather than throwing — a poisoned key must not
 * take the thread down with it.
 */
export function createChatHistoryStore(state: ChatStateLike): NoeticChatHistoryStore {
  const appendChain = new Map<string, Promise<void>>();

  const readItems = async (threadId: string): Promise<Item[]> => {
    const raw = await state.get(HISTORY_PREFIX + threadId);
    if (!raw) {
      return [];
    }
    const parsed = parseStored(raw);
    if (!parsed) {
      console.warn(`[noetic-chat-sdk] corrupt history for thread '${threadId}'; starting fresh.`);
      return [];
    }
    return parsed;
  };

  return {
    readChatHistory: readItems,
    appendChatItem(threadId, item) {
      // Chain appends per thread so concurrent in-process calls cannot
      // interleave their read-modify-write cycles and drop items.
      const previous = appendChain.get(threadId) ?? Promise.resolve();
      const next = previous.then(async () => {
        const items = await readItems(threadId);
        items.push(item);
        await state.set(HISTORY_PREFIX + threadId, JSON.stringify(items));
      });
      const tail = next.catch(() => {});
      appendChain.set(threadId, tail);
      // Drop the chain entry once it settles and nothing queued behind it —
      // otherwise the map keeps one promise per thread ever seen, forever.
      void tail.then(() => {
        if (appendChain.get(threadId) === tail) {
          appendChain.delete(threadId);
        }
      });
      return next;
    },
    async isSeeded(threadId) {
      return (await state.get(SEEDED_PREFIX + threadId)) === '1';
    },
    async markSeeded(threadId) {
      await state.set(SEEDED_PREFIX + threadId, '1');
    },
  };
}

function parseStored(raw: string): Item[] | null {
  try {
    const result = StoredItemsSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
