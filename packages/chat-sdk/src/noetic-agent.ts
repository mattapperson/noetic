import type { DeliveryMode, Item, StreamEvent, StreamingItem } from '@noetic-tools/types';
import type { ChatMessageLike, ChatThreadLike } from './chat-types';
import type { ChatHarness } from './harness-contract';
import type { NoeticChatHistoryStore } from './history-store';
import type { StreamToChatChunksOptions } from './stream-to-chunks';
import { streamToChatChunks } from './stream-to-chunks';
import type { ToItemsOptions } from './to-items';
import { toItems } from './to-items';

export interface NoeticAgentOptions {
  harness: ChatHarness;
  /** Platform messages fetched to seed a thread on first contact. Default 20; 0 disables seeding. */
  historyLimit?: number;
  /**
   * Durable history store (see `createChatHistoryStore`). When set, threads
   * seed from the store instead of refetching platform history after a
   * restart, and every turn's items are persisted to it.
   */
  history?: NoeticChatHistoryStore;
  /** How a message lands when a turn is already running. Default: the harness default. */
  deliveryMode?: DeliveryMode;
  /** Maps a chat thread to a harness thread id. Default: the thread's own id. */
  threadId?: (thread: ChatThreadLike) => string;
  /** Conversion options for seeding and for the triggering message. */
  seed?: ToItemsOptions;
  taskTitle?: StreamToChatChunksOptions['taskTitle'];
  abortNotice?: StreamToChatChunksOptions['abortNotice'];
  /** Called instead of rethrowing when the handler fails. */
  onError?: (error: unknown, thread: ChatThreadLike) => void | Promise<void>;
}

/**
 * Bind a Noetic harness to Chat SDK as an `onSubscribedMessage` handler:
 *
 * ```typescript
 * chat.onSubscribedMessage(noeticAgent({ harness }));
 * ```
 *
 * On a thread's first message the platform history (or the durable store) is
 * seeded into the harness session; every message then becomes a harness turn
 * whose event stream posts back to the thread as streaming markdown plus task
 * cards for tool calls.
 */
export function noeticAgent(
  options: NoeticAgentOptions,
): (thread: ChatThreadLike, message: ChatMessageLike) => Promise<void> {
  const session: AgentSession = {
    options,
    historyLimit: options.historyLimit ?? 20,
    resolveThreadId: options.threadId ?? ((thread: ChatThreadLike) => thread.id),
    seededThreads: new Set<string>(),
    pumpingThreads: new Set<string>(),
    persistedIds: new Map<string, Set<string>>(),
  };

  return async (thread, message) => {
    try {
      await handleMessage(session, thread, message);
    } catch (error) {
      if (!options.onError) {
        throw error;
      }
      await options.onError(error, thread);
    }
  };
}

interface AgentSession {
  options: NoeticAgentOptions;
  historyLimit: number;
  resolveThreadId: (thread: ChatThreadLike) => string;
  /** Threads whose harness session this process has successfully seeded. */
  seededThreads: Set<string>;
  /** Threads whose item-persistence pump this process has already started. */
  pumpingThreads: Set<string>;
  /**
   * Item ids already persisted, per thread. The item stream emits the same
   * completed item more than once (cumulative snapshots), and a restarted
   * pump replays the whole buffer — this is what keeps the store free of
   * duplicates in both cases.
   */
  persistedIds: Map<string, Set<string>>;
}

async function handleMessage(
  session: AgentSession,
  thread: ChatThreadLike,
  message: ChatMessageLike,
): Promise<void> {
  const { options } = session;
  const threadId = session.resolveThreadId(thread);

  await ensureSeeded({
    session,
    thread,
    threadId,
    trigger: message,
  });

  const input = toItems(
    [
      message,
    ],
    options.seed,
  );
  if (input.length === 0) {
    return;
  }

  startHistoryPump(session, threadId);
  // Attach BEFORE execute(): `turn_started` is emitted synchronously inside
  // execute(), and the broadcaster discards events whenever a
  // previously-consumed stream has no live consumer — a subscriber attached
  // afterwards would miss the whole turn and post() would never resolve.
  const events = attachEvents(options.harness, threadId);

  const messageId = crypto.randomUUID();
  await persistItems(session, threadId, input);
  await options.harness.execute(input, {
    threadId,
    messageId,
    deliveryMode: options.deliveryMode,
  });
  await thread.post(
    streamToChatChunks(events, {
      messageId,
      taskTitle: options.taskTitle,
      abortNotice: options.abortNotice,
    }),
  );
}

/** Eagerly bind an iterator so the broadcaster registers the consumer now, not at first read. */
function attachEvents(harness: ChatHarness, threadId: string): AsyncIterable<StreamEvent> {
  const iterator = harness
    .getFullStream({
      threadId,
    })
    [Symbol.asyncIterator]();
  return {
    [Symbol.asyncIterator]: () => iterator,
  };
}

/**
 * Seed once per thread, marking the thread seeded only on SUCCESS — a failed
 * platform fetch must not poison the thread for the process lifetime. Seed
 * failure is non-fatal: the turn still runs (unseeded), and the next message
 * retries; `seedSessionHistory` replaces accumulated items with platform
 * truth, which includes anything posted meanwhile.
 */
async function ensureSeeded(params: {
  session: AgentSession;
  thread: ChatThreadLike;
  threadId: string;
  trigger: ChatMessageLike;
}): Promise<void> {
  const { session, thread, threadId, trigger } = params;
  if (session.seededThreads.has(threadId)) {
    return;
  }
  try {
    await seedThread({
      session,
      thread,
      threadId,
      trigger,
    });
    session.seededThreads.add(threadId);
  } catch (error) {
    if (session.options.onError) {
      await session.options.onError(error, thread);
    } else {
      console.warn(
        `[noetic-chat-sdk] seeding thread '${threadId}' failed; continuing unseeded:`,
        error,
      );
    }
  }
}

async function seedThread(params: {
  session: AgentSession;
  thread: ChatThreadLike;
  threadId: string;
  trigger: ChatMessageLike;
}): Promise<void> {
  const { session, thread, threadId, trigger } = params;
  const { options, historyLimit } = session;
  const store = options.history;

  if (store && (await store.isSeeded(threadId))) {
    const items = await store.readChatHistory(threadId);
    if (items.length > 0) {
      options.harness.seedSessionHistory(threadId, items);
    }
    registerPersisted(session, threadId, items);
    return;
  }

  if (historyLimit <= 0) {
    await store?.markSeeded(threadId);
    return;
  }

  const { messages } = await thread.adapter.fetchMessages(thread.id, {
    limit: historyLimit,
  });
  const history = messages.filter((m) => m.id !== trigger.id);
  const items = toItems(history, options.seed);
  if (items.length > 0) {
    options.harness.seedSessionHistory(threadId, items);
  }
  await persistItems(session, threadId, items);
  await store?.markSeeded(threadId);
}

/**
 * Persist completed model items as they stream. Runs detached for the
 * process lifetime — the item stream spans turns, and awaiting it would
 * deadlock the handler against its own turn.
 */
function startHistoryPump(session: AgentSession, threadId: string): void {
  const store = session.options.history;
  if (!store || session.pumpingThreads.has(threadId)) {
    return;
  }
  session.pumpingThreads.add(threadId);
  void pumpHistory(session, threadId, store).catch(() => {
    // A dead pump only pauses persistence; the next message restarts it, and
    // the persisted-id set keeps the buffer replay from duplicating history.
    session.pumpingThreads.delete(threadId);
  });
}

async function pumpHistory(
  session: AgentSession,
  threadId: string,
  store: NoeticChatHistoryStore,
): Promise<void> {
  const persisted = persistedFor(session, threadId);
  for await (const item of session.options.harness.getItemStream({
    threadId,
  })) {
    if (!item.isComplete) {
      continue;
    }
    const id = itemId(item);
    if (id) {
      if (persisted.has(id)) {
        continue;
      }
      persisted.add(id);
    }
    await store.appendChatItem(threadId, stripIsComplete(item));
  }
}

async function persistItems(
  session: AgentSession,
  threadId: string,
  items: ReadonlyArray<Item>,
): Promise<void> {
  const store = session.options.history;
  if (!store) {
    return;
  }
  const persisted = persistedFor(session, threadId);
  for (const item of items) {
    const id = itemId(item);
    if (id) {
      if (persisted.has(id)) {
        continue;
      }
      persisted.add(id);
    }
    await store.appendChatItem(threadId, item);
  }
}

function registerPersisted(
  session: AgentSession,
  threadId: string,
  items: ReadonlyArray<Item>,
): void {
  const persisted = persistedFor(session, threadId);
  for (const item of items) {
    const id = itemId(item);
    if (id) {
      persisted.add(id);
    }
  }
}

function persistedFor(session: AgentSession, threadId: string): Set<string> {
  let ids = session.persistedIds.get(threadId);
  if (!ids) {
    ids = new Set();
    session.persistedIds.set(threadId, ids);
  }
  return ids;
}

function itemId(item: Item | StreamingItem): string | null {
  return 'id' in item && typeof item.id === 'string' ? item.id : null;
}

function stripIsComplete(streamingItem: StreamingItem): Item {
  const { isComplete: _isComplete, ...item } = streamingItem;
  return item;
}
