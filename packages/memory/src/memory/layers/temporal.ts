import type { MemoryLayer, MemoryScope } from '@noetic-tools/types';
import {
  collectInputText,
  collectOutputText,
  createMessage,
  estimateTokens,
  Slot,
} from '@noetic-tools/types';
import { z } from 'zod';
import { layerFn } from '../layer-provides';

//#region Public types

/**
 * A single remembered fact tied to an instant.
 * @public
 */
export interface TemporalFact {
  /** ISO-8601 timestamp the fact is associated with (when it happened / was stated). */
  ts: string;
  /** The fact, stated tersely. */
  fact: string;
}

/**
 * Result of a temporal memory search.
 * @public
 */
export interface TemporalSearchResult {
  /** Matching facts, most relevant first. */
  facts: string[];
  /** A resolved date for the query, when one applies (ISO-8601 or a natural phrase). */
  date?: string;
  /** True when `date` is approximate ("around March", "a few weeks ago"). */
  fuzzy?: boolean;
}

/**
 * Extracts timestamped facts from a batch of conversation text. Host-injected so
 * the layer stays LLM-agnostic and tree-shakable (mirrors `observationalMemory`'s
 * `observer`). When omitted, the layer only buffers — it never fabricates facts.
 * @public
 */
export type FactExtractor = (input: { transcript: string; now: string }) => Promise<TemporalFact[]>;

/**
 * Searches the stored fact ledger for a query, optionally resolving a date.
 * Host-injected. When omitted, search falls back to returning the raw ledger.
 * @public
 */
export type FactSearcher = (input: {
  query: string;
  facts: ReadonlyArray<TemporalFact>;
  now: string;
}) => Promise<TemporalSearchResult>;

/**
 * Configuration for {@link temporalMemory}.
 * @public
 */
export interface TemporalMemoryConfig {
  /** Returns "now" for date grounding/extraction. Defaults to the system clock. */
  now?: () => Date;
  /** Memory scope. Defaults to `'resource'` (long-term, cross-session). */
  scope?: MemoryScope;
  /** LLM-backed fact extractor. Without it, `store` only buffers (no extraction). */
  extract?: FactExtractor;
  /** LLM-backed fact searcher. Without it, `searchMemory` returns the raw ledger. */
  search?: FactSearcher;
  /** Buffered output tokens that trigger an extraction pass. Default 2000. */
  bufferThreshold?: number;
  /** Maximum facts retained (oldest dropped beyond this). Default 200. */
  maxFacts?: number;
  /** Inject a `<current_datetime>` grounding block on recall. Default true. */
  groundDateTime?: boolean;
  /** Inject the fact ledger on recall (vs. on-demand via the search tool). Default false. */
  injectLedger?: boolean;
}

//#endregion

//#region State

interface TemporalState {
  /** ISO timestamp → facts recorded at that instant. */
  facts: Record<string, string[]>;
  /** Accumulated output text awaiting extraction. */
  buffer: string[];
  bufferTokens: number;
  version: number;
}

function emptyState(): TemporalState {
  return {
    facts: {},
    buffer: [],
    bufferTokens: 0,
    version: 0,
  };
}

const DEFAULT_BUFFER_THRESHOLD_TOKENS = 2_000;
const DEFAULT_MAX_FACTS = 200;

//#endregion

//#region Date grounding

const WEEKDAYS = [
  'Sun',
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
] as const;

/** Formats an instant as `YYYY/MM/DD (Ddd) HH:MM` using local fields. */
function formatNow(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const day = WEEKDAYS[date.getDay()];
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} (${day}) ${hh}:${min}`;
}

function renderDateTimeBlock(date: Date): string {
  return [
    '<current_datetime>',
    `Now: ${formatNow(date)}`,
    'Resolve relative time ("N days/weeks/months ago", "last/next <weekday>",',
    '"before/after", "first/earliest/most recent", "how long since/until") against',
    'Now above and compute the difference explicitly before answering. Use the',
    'temporal/searchMemory tool to look up when something happened.',
    '</current_datetime>',
  ].join('\n');
}

//#endregion

//#region Ledger helpers

/** Flattens the KV ledger into a flat, chronologically sorted fact list. */
function ledgerToFacts(state: TemporalState): TemporalFact[] {
  const out: TemporalFact[] = [];
  for (const [ts, facts] of Object.entries(state.facts)) {
    for (const fact of facts) {
      out.push({
        ts,
        fact,
      });
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out;
}

/** Merges new facts into the KV ledger, capping total facts to `maxFacts` (oldest dropped). */
function mergeFacts(
  state: TemporalState,
  incoming: ReadonlyArray<TemporalFact>,
  maxFacts: number,
): Record<string, string[]> {
  const facts: Record<string, string[]> = {};
  for (const [ts, list] of Object.entries(state.facts)) {
    facts[ts] = [
      ...list,
    ];
  }
  for (const { ts, fact } of incoming) {
    const list = facts[ts] ?? [];
    if (!list.includes(fact)) {
      list.push(fact);
    }
    facts[ts] = list;
  }
  return capLedger(facts, maxFacts);
}

/**
 * Caps the ledger at FACT granularity: when over `maxFacts`, drops the OLDEST
 * facts and always retains the most recent `maxFacts`. Operating per-fact (not
 * per-timestamp) prevents a single oversized extraction at one instant from
 * evicting the just-added newest facts.
 */
function capLedger(facts: Record<string, string[]>, maxFacts: number): Record<string, string[]> {
  let total = 0;
  for (const list of Object.values(facts)) {
    total += list.length;
  }
  if (total <= maxFacts) {
    return facts;
  }
  // Flatten chronologically (oldest first; stable within a timestamp), then keep
  // only the most recent `maxFacts`.
  const flat: TemporalFact[] = [];
  for (const [ts, list] of Object.entries(facts)) {
    for (const fact of list) {
      flat.push({
        ts,
        fact,
      });
    }
  }
  flat.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const kept = flat.slice(flat.length - maxFacts);
  const capped: Record<string, string[]> = {};
  for (const { ts, fact } of kept) {
    const list = capped[ts] ?? [];
    list.push(fact);
    capped[ts] = list;
  }
  return capped;
}

/**
 * Renders the `<remembered_facts>` block, greedily including the most recent
 * facts first and stopping before the block would exceed `budget` tokens.
 * Returns `null` when there are no facts or not even one fits.
 */
function renderLedgerBlock(facts: ReadonlyArray<TemporalFact>, budget: number): string | null {
  if (facts.length === 0) {
    return null;
  }
  const open = '<remembered_facts>';
  const close = '</remembered_facts>';
  // Most recent first so the budget retains the freshest facts.
  const ordered = [
    ...facts,
  ].reverse();
  const selected: string[] = [];
  for (const f of ordered) {
    const line = `- [${f.ts}] ${f.fact}`;
    const candidate = [
      open,
      ...selected,
      line,
      close,
    ].join('\n');
    if (estimateTokens(candidate) > budget) {
      break;
    }
    selected.push(line);
  }
  if (selected.length === 0) {
    return null;
  }
  return [
    open,
    ...selected,
    close,
  ].join('\n');
}

interface AccumulateConfig {
  threshold: number;
  maxFacts: number;
  now: () => Date;
  extract?: FactExtractor;
}

/**
 * Appends `texts` into the buffer and, once the token threshold is crossed (and
 * an extractor is configured), distills the buffer into ledger facts. Shared by
 * `store` (assistant output) and `onItemAppend` (user/tool input).
 */
async function accumulate(
  s: TemporalState,
  texts: string[],
  cfg: AccumulateConfig,
): Promise<TemporalState> {
  const newBuffer = [
    ...s.buffer,
    ...texts,
  ];
  const newTokens = texts.reduce((sum, t) => sum + estimateTokens(t), 0);
  const totalBufferTokens = s.bufferTokens + newTokens;

  if (cfg.extract && totalBufferTokens >= cfg.threshold && newBuffer.length > 0) {
    const extracted = await cfg.extract({
      transcript: newBuffer.join('\n'),
      now: formatNow(cfg.now()),
    });
    return {
      facts: mergeFacts(s, extracted, cfg.maxFacts),
      buffer: [],
      bufferTokens: 0,
      version: s.version + 1,
    };
  }

  return {
    ...s,
    buffer: newBuffer,
    bufferTokens: totalBufferTokens,
  };
}

//#endregion

//#region Layer

/**
 * A non-atomic, LLM-backed memory layer that extracts timestamped facts from the
 * conversation into a key-value ledger (key = ISO timestamp) and exposes a
 * `temporal/searchMemory` tool for relative-time recall — given a fact/query it
 * returns matching facts and, when applicable, a resolved (possibly fuzzy) date.
 *
 * The layer is LLM-agnostic: the host injects `extract` and `search` callbacks
 * (mirrors `observationalMemory`'s `observer`), keeping `memory/` tree-shakable.
 * Without them, the layer still buffers text and the search tool returns the raw
 * ledger — it never fabricates facts. A `<current_datetime>` grounding block is
 * injected on recall by default to anchor relative-time reasoning.
 *
 * @public
 * @param config - Clock, scope, injected LLM callbacks, and tuning knobs.
 * @returns A `MemoryLayer` with a fact-ledger store + `searchMemory` tool.
 */
export function temporalMemory(config?: TemporalMemoryConfig): MemoryLayer<TemporalState> {
  const now = config?.now ?? ((): Date => new Date());
  const threshold = config?.bufferThreshold ?? DEFAULT_BUFFER_THRESHOLD_TOKENS;
  const maxFacts = config?.maxFacts ?? DEFAULT_MAX_FACTS;
  const groundDateTime = config?.groundDateTime ?? true;
  const injectLedger = config?.injectLedger ?? false;
  const extract = config?.extract;
  const search = config?.search;

  return {
    id: 'temporal',
    name: 'Temporal Memory',
    // Grounding sits near the top of the window, before reasoning content.
    slot: Slot.REMINDER,
    scope: config?.scope ?? 'resource',
    budget: {
      min: 0,
      max: injectLedger ? 800 : 200,
    },
    timeouts: {
      store: 60_000,
    },
    provides: {
      searchMemory: layerFn<
        {
          query: string;
        },
        TemporalSearchResult,
        TemporalState
      >({
        description:
          'Search remembered facts about the user by topic or fact, and resolve relative time. Returns matching facts and, when the query implies a time, a resolved date (which may be approximate).',
        input: z.object({
          query: z.string(),
        }),
        output: z.object({
          facts: z.array(z.string()),
          date: z.string().optional(),
          fuzzy: z.boolean().optional(),
        }),
        execute: async (args, state) => {
          const facts = ledgerToFacts(state ?? emptyState());
          if (!search) {
            return {
              result: {
                facts: facts.map((f) => `[${f.ts}] ${f.fact}`),
              },
            };
          }
          const result = await search({
            query: args.query,
            facts,
            now: formatNow(now()),
          });
          return {
            result,
          };
        },
      }),
    },
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<TemporalState>('state');
        return {
          state: saved ?? emptyState(),
        };
      },

      async recall({ state, budget }) {
        const blocks: string[] = [];
        if (groundDateTime) {
          blocks.push(renderDateTimeBlock(now()));
        }
        if (injectLedger) {
          // Reserve whatever the grounding block (plus its `\n\n` separator)
          // already consumed so the rendered output stays within budget.
          const used = blocks.length > 0 ? estimateTokens(`${blocks.join('\n\n')}\n\n`) : 0;
          const ledgerBlock = renderLedgerBlock(
            ledgerToFacts(state ?? emptyState()),
            budget - used,
          );
          if (ledgerBlock !== null) {
            blocks.push(ledgerBlock);
          }
        }
        if (blocks.length === 0) {
          return null;
        }
        const text = blocks.join('\n\n');
        return {
          items: [
            createMessage(text, 'developer'),
          ],
          tokenCount: estimateTokens(text),
        };
      },

      // Captures assistant output text.
      async store({ newItems, state }) {
        const s = state ?? emptyState();
        const texts = collectOutputText(newItems);
        return {
          state: await accumulate(s, texts, {
            threshold,
            maxFacts,
            now,
            extract,
          }),
        };
      },

      // Captures user input and tool output text (pass-through; no transform).
      async onItemAppend({ items, state }) {
        const s = state ?? emptyState();
        const texts = collectInputText(items);
        if (texts.length === 0) {
          return {
            items,
          };
        }
        return {
          items,
          state: await accumulate(s, texts, {
            threshold,
            maxFacts,
            now,
            extract,
          }),
        };
      },

      async onSpawn({ parentState }) {
        return {
          childState: structuredClone(parentState),
        };
      },
    },
  } satisfies MemoryLayer<TemporalState>;
}

//#endregion
