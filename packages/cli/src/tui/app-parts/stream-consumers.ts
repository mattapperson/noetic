/**
 * Long-lived consumers of the harness's session streams.
 *
 * Each wiring (one per harness instance) gets a cancellation seam:
 * - `signal` aborts the `for await` itself (the broadcast streams never
 *   complete on session abort, so without it the loops stay parked holding
 *   stale closures);
 * - `isStale()` gates every side effect, covering the window between an
 *   epoch bump (e.g. `/clear`, `/model` swap) and the abort, plus any effect
 *   that would land after an `await` spanning the bump.
 *
 * A stale or aborted consumer must leave NO trace: no entries, no status
 * flips, no usage accounting, no persistence.
 */

import type { MutableRefObject } from 'react';
import { abortableIterable } from '../../util/abortable-iterable.js';
import type {
  HarnessResponse,
  HarnessStatus,
  Item,
  LastLayerUsage,
  StreamEvent,
  StreamingItem,
} from './deps.js';
import {
  buildErrorEntry,
  extractEventSuffix,
  isFrameworkEvent,
  markUserEntrySent,
} from './helpers.js';
import type { AssistantEntry, ChatStatus, ConversationEntry, StreamMetricsRefs } from './ui.js';
import { appendOrUpdateEntry, extractTextContent, getItemId } from './ui.js';

//#region Types

/** The slice of `AgentHarness` the stream consumers actually use — narrow so
 *  tests can drive the loops with a hand-rolled fake. */
export interface StreamConsumerHarness {
  getItemStream(scope: { threadId: string }): AsyncIterable<StreamingItem>;
  getFullStream(scope: { threadId: string }): AsyncIterable<StreamEvent>;
  getAgentResponse(scope: { threadId: string }): Promise<HarnessResponse>;
  getStatus(scope: { threadId: string }): HarnessStatus;
}

interface ConsumerLifecycle {
  /** True once this wiring's session epoch has been superseded. */
  isStale: () => boolean;
  /** Aborts the stream iteration itself. */
  signal: AbortSignal;
}

export interface ConsumeItemsOpts extends ConsumerLifecycle {
  harness: StreamConsumerHarness;
  threadId: string;
  setEntries: (updater: (prev: ConversationEntry[]) => ConversationEntry[]) => void;
  streamMetrics: StreamMetricsRefs;
  perItemCharsRef: MutableRefObject<Map<string, number>>;
}

export interface ConsumeEventsOpts extends ConsumerLifecycle {
  harness: StreamConsumerHarness;
  threadId: string;
  setEntries: (updater: (prev: ConversationEntry[]) => ConversationEntry[]) => void;
  setStatus: (s: ChatStatus) => void;
  setLastLayerUsage: (u: LastLayerUsage | undefined) => void;
  lastLayerUsageRef: {
    current: LastLayerUsage | undefined;
  };
  pendingMessageIdsRef: {
    current: Set<string>;
  };
  streamMetrics: StreamMetricsRefs;
  perItemCharsRef: MutableRefObject<Map<string, number>>;
  /** Called once per turn_completed/turn_aborted with the latest response. No-op if persistence is disabled. */
  onTurnSettled: (resp: {
    items: ReadonlyArray<Item>;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedTokens?: number;
    };
    cost?: number;
    lastLayerUsage: LastLayerUsage | undefined;
  }) => void;
}

//#endregion

//#region Item stream

/**
 * For each streaming assistant message item, bump the live output-char counter
 * by whatever new text appeared since the last yield of that item. The
 * counter is reset per-turn by `consumeFullStream` on `turn_started`.
 */
export function trackLiveOutput(opts: {
  item: AssistantEntry;
  streamMetrics: StreamMetricsRefs;
  perItemCharsRef: MutableRefObject<Map<string, number>>;
}): void {
  if (opts.item.type !== 'message') {
    return;
  }
  const id = getItemId(opts.item);
  const currentLen = extractTextContent(opts.item).length;
  const previousLen = opts.perItemCharsRef.current.get(id) ?? 0;
  if (currentLen <= previousLen) {
    return;
  }
  const delta = currentLen - previousLen;
  opts.perItemCharsRef.current.set(id, currentLen);
  opts.streamMetrics.liveOutputChars.current += delta;
  if (opts.streamMetrics.firstTokenAt.current === null) {
    opts.streamMetrics.firstTokenAt.current = Date.now();
  }
}

export async function consumeItemStream(opts: ConsumeItemsOpts): Promise<void> {
  try {
    const stream = opts.harness.getItemStream({
      threadId: opts.threadId,
    });
    for await (const item of abortableIterable(stream, opts.signal)) {
      if (opts.isStale()) {
        return;
      }
      trackLiveOutput({
        item,
        streamMetrics: opts.streamMetrics,
        perItemCharsRef: opts.perItemCharsRef,
      });
      opts.setEntries((prev) => appendOrUpdateEntry(prev, item));
    }
  } catch (err: unknown) {
    // A stale/aborted consumer's errors are teardown noise — never surface
    // them into the (new) session's transcript.
    if (opts.isStale() || opts.signal.aborted) {
      return;
    }
    opts.setEntries((prev) => [
      ...prev,
      buildErrorEntry(err),
    ]);
  }
}

//#endregion

//#region Full stream

export function resetTurnMetrics(opts: {
  streamMetrics: StreamMetricsRefs;
  perItemCharsRef: MutableRefObject<Map<string, number>>;
}): void {
  opts.streamMetrics.turnStartedAt.current = Date.now();
  opts.streamMetrics.firstTokenAt.current = null;
  opts.streamMetrics.liveOutputChars.current = 0;
  opts.streamMetrics.liveTokens.current = null;
  opts.perItemCharsRef.current.clear();
}

function handleTurnStarted(opts: ConsumeEventsOpts, data: Record<string, unknown>): void {
  const rawIds = data.messageIds;
  const ids = Array.isArray(rawIds)
    ? rawIds.filter((id): id is string => typeof id === 'string')
    : [];
  opts.setEntries((prev) => {
    let next = prev;
    for (const id of ids) {
      if (opts.pendingMessageIdsRef.current.has(id)) {
        opts.pendingMessageIdsRef.current.delete(id);
        next = markUserEntrySent(next, id);
      }
    }
    return next;
  });
  resetTurnMetrics({
    streamMetrics: opts.streamMetrics,
    perItemCharsRef: opts.perItemCharsRef,
  });
  opts.setStatus('streaming');
}

async function handleTurnSettled(opts: ConsumeEventsOpts): Promise<void> {
  try {
    const resp = await opts.harness.getAgentResponse({
      threadId: opts.threadId,
    });
    // The await above can span a /clear or harness swap — re-check before
    // touching ANY shared state (usage refs, persistence, status).
    if (opts.isStale()) {
      return;
    }
    opts.lastLayerUsageRef.current = resp.lastLayerUsage;
    opts.setLastLayerUsage(resp.lastLayerUsage);
    // Clear the streaming-tokens ref so the context panel header falls through
    // to the authoritative `LastLayerUsage` total (which includes system prompt,
    // tools, and memory-layer overhead) instead of the stale input+output tally.
    opts.streamMetrics.liveTokens.current = null;
    opts.onTurnSettled({
      items: resp.items,
      usage: resp.usage,
      cost: resp.cost,
      lastLayerUsage: resp.lastLayerUsage,
    });
  } catch {
    // getAgentResponse can only reject if no session exists; here it does.
  }
  if (opts.isStale()) {
    return;
  }
  // Trust the runner's kind: if the next turn is already running
  // ('generating'), its turn_started will bounce us back to 'streaming';
  // otherwise we're genuinely idle and can accept input again.
  const runnerStatus = opts.harness.getStatus({
    threadId: opts.threadId,
  });
  if (runnerStatus.kind === 'generating') {
    opts.setStatus('streaming');
  } else {
    opts.streamMetrics.turnStartedAt.current = null;
    opts.setStatus('ready');
  }
}

export async function consumeFullStream(opts: ConsumeEventsOpts): Promise<void> {
  try {
    const stream = opts.harness.getFullStream({
      threadId: opts.threadId,
    });
    for await (const event of abortableIterable(stream, opts.signal)) {
      if (opts.isStale()) {
        return;
      }
      if (!isFrameworkEvent(event)) {
        continue;
      }
      const suffix = extractEventSuffix(event.type);
      if (suffix === 'turn_started') {
        handleTurnStarted(opts, event.data);
        continue;
      }
      if (suffix === 'turn_completed' || suffix === 'turn_aborted') {
        await handleTurnSettled(opts);
      }
    }
  } catch {
    // Stream ended — normal on harness swap.
  }
}

//#endregion
