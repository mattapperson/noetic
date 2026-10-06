import type { CompactionItem, Item, ProjectionPolicy } from '@noetic-tools/types';
import {
  COMPACTION_ITEM_TYPE,
  createMessage,
  estimateTokens,
  frameworkCast,
} from '@noetic-tools/types';
import { stripUnresolvedToolCalls } from './strip-unresolved';

//#region Types

interface AssembleViewParams {
  systemPromptItems: Item[];
  /** Anchor band — layer output rendered before history, where a prompt cache can hold it. */
  layerOutputItems: Item[];
  historyItems: Item[];
  /** Live band — layer output rendered after history, slot-ascending. */
  liveLayerItems?: Item[];
  /** Supersedes for anchored layers whose pinned output went stale. */
  deltaItems?: Item[];
  /** Items that must land last, after everything else. Never dropped. */
  tailItems?: Item[];
  policy?: ProjectionPolicy;
}

/** @public Result of measuring folded history against a compaction threshold. */
export interface HistoryPressure {
  /** Estimated tokens of the folded history. */
  historyTokens: number;
  /** The `compactAt` threshold in effect. */
  compactAt: number;
  /** True when historyTokens > compactAt — compaction should run. */
  overThreshold: boolean;
}

/** @public Parameters for `createCompaction`. */
export interface CreateCompactionParams {
  /** The RAW item log the compaction indexes into. */
  items: ReadonlyArray<Item>;
  /** How many leading raw-log items the summary replaces. */
  replacesUntil: number;
  /** The summary that stands in for the replaced prefix. */
  summary: string;
}

/** @public Parameters for `compactHistory`. */
export interface CompactHistoryParams {
  /** The RAW item log to compact. */
  log: ReadonlyArray<Item>;
  /** How many trailing raw-log items to leave uncompacted. */
  keepRecent: number;
  /** Produces the summary for the covered prefix. */
  summarize: (replaced: ReadonlyArray<Item>) => string | Promise<string>;
}

//#endregion

//#region Helpers

/** Conservative per-item token estimate (serialized form ⇒ never under-counts). */
function itemTokens(item: Item): number {
  return estimateTokens(JSON.stringify(item));
}

function isCompactionItem(item: Item): item is Item & CompactionItem {
  return item.type === COMPACTION_ITEM_TYPE;
}

/** Render a compaction summary as a developer message the model can read. */
function renderCompaction(compaction: CompactionItem): Item {
  return createMessage(
    `<compacted_history items="${compaction.replacedCount}">\n${compaction.summary}\n</compacted_history>`,
    'developer',
  );
}

function totalTokens(items: ReadonlyArray<Item>): number {
  let total = 0;
  for (const item of items) {
    total += itemTokens(item);
  }
  return total;
}

/**
 * Keep items from a slot-ascending list within `budget`, considering items in
 * slot order and dropping each non-fitting item INDIVIDUALLY. Layer-output
 * items are independent contributions (no contiguity requirement, unlike
 * history), so an oversized low-slot item must not evict later items that
 * still fit — lower-slot output gets first claim on the budget, and
 * higher-slot output is dropped first when space runs out.
 */
function keepFrontWithinBudget(items: ReadonlyArray<Item>, budget: number): Item[] {
  const kept: Item[] = [];
  let used = 0;
  for (const item of items) {
    const cost = itemTokens(item);
    if (used + cost > budget) {
      continue;
    }
    kept.push(item);
    used += cost;
  }
  return kept;
}

/**
 * Keep the MOST RECENT history items within `budget`, then strip any orphan
 * tool calls/outputs left dangling at the slice boundary. An optional
 * `windowSize` caps item count first (sliding-window overflow mode).
 */
function keepRecentWithinBudget(
  items: ReadonlyArray<Item>,
  budget: number,
  windowSize?: number,
): Item[] {
  const windowed = windowSize ? items.slice(-windowSize) : items;
  const kept: Item[] = [];
  let used = 0;
  for (let i = windowed.length - 1; i >= 0; i--) {
    const item = windowed[i];
    const cost = itemTokens(item);
    if (used + cost > budget) {
      break;
    }
    kept.unshift(item);
    used += cost;
  }
  return stripUnresolvedToolCalls(kept);
}

//#endregion

//#region Public API

/**
 * Assemble the model's context window in bands:
 *
 * ```
 * system | anchor layers | history | live layers | supersedes | tail
 * ```
 *
 * The split exists for the prompt cache, which matches on a prefix. Stable
 * layer output sits ahead of history where it can be cached; volatile output
 * sits after it, where re-rendering costs almost nothing. Both bands arrive
 * slot-ascending.
 *
 * Without a `policy` the bands are concatenated as-is (optionally sliding the
 * history window by `windowSize`). With a `policy` the view is held to a hard
 * token budget, claimed in this order: system items, then anchor output, then
 * live output, then supersedes, then the tail — with history taking whatever
 * remains and keeping the most recent turns.
 *
 * Supersedes are claimed ahead of history, and all together or not at all: a
 * dropped supersede would leave the model reading a pinned block the runtime
 * knows is stale. The caller re-anchors instead — see `prepareBandedView`.
 */
export function assembleView({
  systemPromptItems,
  layerOutputItems,
  historyItems,
  liveLayerItems = [],
  deltaItems = [],
  tailItems = [],
  policy,
}: AssembleViewParams): Item[] {
  if (!policy) {
    return [
      ...systemPromptItems,
      ...layerOutputItems,
      ...historyItems,
      ...liveLayerItems,
      ...deltaItems,
      ...tailItems,
    ];
  }

  const budget = Math.max(0, policy.tokenBudget - policy.responseReserve);
  // System items are never dropped — they anchor the conversation.
  let left = Math.max(0, budget - totalTokens(systemPromptItems));

  const keptAnchor = keepFrontWithinBudget(layerOutputItems, left);
  left = Math.max(0, left - totalTokens(keptAnchor));

  const keptLive = keepFrontWithinBudget(liveLayerItems, left);
  left = Math.max(0, left - totalTokens(keptLive));

  // The tail carries steering guidance, which must reach the model whatever the
  // budget says — it is the correction the retry exists to deliver.
  left = Math.max(0, left - totalTokens(tailItems));

  // Supersedes are never dropped either. Each one corrects a pinned block that
  // is already in the view, so dropping one leaves the model reading content
  // the runtime knows is stale — silent corruption, and far worse than losing
  // a turn of history. History absorbs the cost; `deltaBudgetFraction` keeps
  // the supersedes from growing large enough for that to hurt.
  left = Math.max(0, left - totalTokens(deltaItems));

  const keptHistory = keepRecentWithinBudget(historyItems, left, policy.windowSize);

  return [
    ...systemPromptItems,
    ...keptAnchor,
    ...keptHistory,
    ...keptLive,
    ...deltaItems,
    ...tailItems,
  ];
}

/**
 * @public Fold recorded compactions into a history view.
 *
 * The item log is append-only; a compaction is an ordinary logged item that
 * declares "the first `replacesUntil` items are summarized by `summary`".
 * Folding keeps the log immutable (checkpoints, forks, and audits see the full
 * record) while the model sees `[summary, ...items after replacesUntil]`.
 *
 * When multiple compactions exist, the one with the highest `replacesUntil`
 * wins (later compactions subsume earlier ones — their summaries were produced
 * with the earlier summary already in view). Compaction items themselves never
 * appear in the folded view; the winning one renders as a developer message.
 *
 * Runs BEFORE the band assembler, so a compaction genuinely reduces what
 * `assembleView` has to fit — and therefore how much history it has to trim.
 */
export function foldCompactions(items: ReadonlyArray<Item>): Item[] {
  let winner: CompactionItem | null = null;
  for (const item of items) {
    if (isCompactionItem(item) && (!winner || item.replacesUntil > winner.replacesUntil)) {
      winner = item;
    }
  }
  if (!winner) {
    return items.filter((i) => !isCompactionItem(i));
  }
  const kept: Item[] = [
    renderCompaction(winner),
  ];
  for (let i = winner.replacesUntil; i < items.length; i++) {
    const item = items[i];
    if (isCompactionItem(item)) {
      continue;
    }
    kept.push(item);
  }
  // A fold boundary can strand a tool call whose output was compacted away
  // (or vice versa); repair the seam the same way the trimmer does.
  return stripUnresolvedToolCalls(kept);
}

/**
 * @public Whether a log carries any compaction record.
 *
 * Lets a caller skip `foldCompactions` (and its copy) on the overwhelmingly
 * common no-compaction path while still guaranteeing that a compaction item
 * never reaches a provider un-folded.
 */
export function hasCompaction(items: ReadonlyArray<Item>): boolean {
  return items.some(isCompactionItem);
}

/**
 * @public Measure history pressure against the policy's compaction threshold.
 *
 * The caller surfaces `overThreshold` to whatever drives compaction. That is
 * the complementary half of the band assembler's budget enforcement:
 * `assembleView` still trims the oldest history when the view will not fit, but
 * it does so silently. This says when the trim is coming, so the caller can
 * compact — replacing the prefix with a summary — instead of losing it.
 */
export function historyPressure(
  historyItems: ReadonlyArray<Item>,
  policy: ProjectionPolicy,
): HistoryPressure {
  const historyTokens = totalTokens(foldCompactions(historyItems));
  const compactAt =
    policy.compactAt ??
    Math.max(0, Math.floor((policy.tokenBudget - policy.responseReserve) * 0.8));
  return {
    historyTokens,
    compactAt,
    overThreshold: historyTokens > compactAt,
  };
}

/**
 * @public Build the compaction record for a history prefix.
 *
 * The caller supplies the summary (an LLM call, a heuristic, or a verbatim
 * digest — compaction is a composition point, not engine policy) and appends
 * the returned item to the log. Idempotent with respect to prior compactions:
 * `replacesUntil` indexes the RAW log, including any earlier compaction items
 * in the prefix, so stacking compactions is well-defined.
 */
export function createCompaction(params: CreateCompactionParams): CompactionItem {
  const replaced = params.items.slice(0, params.replacesUntil);
  const summaryTokens = estimateTokens(params.summary);
  return {
    id: crypto.randomUUID(),
    type: COMPACTION_ITEM_TYPE,
    status: 'completed',
    replacesUntil: params.replacesUntil,
    summary: params.summary,
    replacedCount: replaced.length,
    tokensSaved: Math.max(0, totalTokens(replaced) - summaryTokens),
  };
}

/**
 * @public Compact a log down to its most recent `keepRecent` items.
 *
 * A thin convenience over `createCompaction`: it works out `replacesUntil` from
 * `keepRecent`, calls `summarize` with exactly the items being replaced, and
 * returns the record for the CALLER to append (`ctx.itemLog.append(...)`).
 * Appending is left to the caller because compaction is an explicit, logged
 * decision — the projector never mutates a log behind the runtime's back.
 *
 * Returns `null` when there is nothing to compact.
 */
export async function compactHistory(params: CompactHistoryParams): Promise<CompactionItem | null> {
  const replacesUntil = params.log.length - Math.max(0, params.keepRecent);
  if (replacesUntil <= 0) {
    return null;
  }
  const summary = await params.summarize(params.log.slice(0, replacesUntil));
  return createCompaction({
    items: params.log,
    replacesUntil,
    summary,
  });
}

/**
 * @public Append-safe view of a compaction record.
 *
 * `CompactionItem` is deliberately outside the `Item` union — nothing renders
 * it directly, the projector folds it — but it must reach `ItemLog.append`,
 * which takes an `Item`. This is the one sanctioned bridge; the item type is
 * registered with the schema registry so the append validates.
 */
export function compactionAsItem(compaction: CompactionItem): Item {
  return frameworkCast<Item>(compaction);
}

//#endregion
