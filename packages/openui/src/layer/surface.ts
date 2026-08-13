/**
 * The `openUiSurface()` context layer — the server-authoritative owner of UI
 * state. The client renderer is a projection of this layer's state, never the
 * other way around: agent renders fold in via `afterModelCall`, client events
 * reduce in via `onItemAppend`, the model sees a budget-trimmed `<ui_surface>`
 * block via `recall`, and thread scope + the runtime's durable write-through
 * make the surface survive resume and reconnect.
 */

import type {
  AfterModelCallParams,
  AfterModelCallResult,
  ContextLayer,
  ContextLayerHooks,
  InputMessageItem,
  Item,
  OnItemAppendParams,
  OnItemAppendResult,
} from '@noetic-tools/types';
import {
  collectOutputText,
  createMessage,
  estimateTokens,
  isAssistantMessage,
  isOutputText,
  Slot,
} from '@noetic-tools/types';
import { z } from 'zod';
import type { UiDocument } from '../lang/document';
import { emptyDocument, mergeDocument, serializeAssignment } from '../lang/document';
import { parseDocument } from '../lang/parser';
import type { UiLibrary } from '../library';
import { validateDocument } from '../library';

//#region UI events

/** @public Interaction kinds a client can send back to the agent. */
export const UiEventKind = {
  /** Two-way-binding update of a `$var`. Reduced into state, dropped from the item log. */
  Set: 'set',
  /** A form (or form-like component) was submitted. */
  Submit: 'submit',
  /** An `Action` block ran. */
  Action: 'action',
  /** An `@ToAssistant(...)` step sent the agent a message. */
  ToAssistant: 'toAssistant',
} as const;

export type UiEventKind = (typeof UiEventKind)[keyof typeof UiEventKind];

/** @public One client-originated UI event, as carried on a `ui-event` item. */
export const UiEventSchema = z.object({
  kind: z.enum([
    UiEventKind.Set,
    UiEventKind.Submit,
    UiEventKind.Action,
    UiEventKind.ToAssistant,
  ]),
  /** The statement ref (or `$var` name for `set`) the event targets. */
  ref: z.string(),
  payload: z.unknown().optional(),
  /**
   * Client-assigned monotonic sequence — dedupe/ordering across reconnects.
   * Scoped to `clientId` when present: each client counts independently.
   */
  seq: z.number().int().nonnegative(),
  /**
   * Stable identifier for the emitting client (a tab, a device). Dedupe
   * watermarks are kept per client, so two clients each starting at seq 0
   * don't shadow each other. Omitted ⇒ the shared legacy watermark.
   */
  clientId: z.string().min(1).max(128).optional(),
  /** Document version the client rendered against when the event fired. */
  version: z.number().int().nonnegative().optional(),
});

export type UiEvent = z.infer<typeof UiEventSchema>;

/** @public The developer-message item shape carrying a UI event. */
export const UiEventItemSchema = z.object({
  id: z.string(),
  type: z.literal('message'),
  role: z.literal('developer'),
  status: z.enum([
    'in_progress',
    'completed',
    'incomplete',
    'failed',
  ]),
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
    }),
  ),
  uiEvent: UiEventSchema,
});

export type UiEventItem = z.infer<typeof UiEventItemSchema>;

/**
 * Build the item a transport appends when the client sends a UI event. It is a
 * developer `message` Item carrying the parsed event on a `uiEvent` field; the
 * surface layer registers `UiEventItemSchema` in `itemSchemas` so the runtime
 * accepts the extra field.
 * @public
 */
export function createUiEventItem(event: UiEvent): Item {
  const parsed = UiEventSchema.parse(event);
  const item: InputMessageItem & {
    uiEvent: UiEvent;
  } = {
    ...createMessage(`<ui_event>${JSON.stringify(parsed)}</ui_event>`, 'developer'),
    uiEvent: parsed,
  };
  return item;
}

function readUiEvent(item: Item): UiEvent | null {
  if (typeof item !== 'object' || item === null || !('uiEvent' in item)) {
    return null;
  }
  const parsed = UiEventSchema.safeParse(item.uiEvent);
  return parsed.success ? parsed.data : null;
}

//#endregion

//#region State

/** @public A terminal interaction recorded on the surface. */
export interface OpenUiInteraction {
  kind: Exclude<UiEventKind, 'set'>;
  ref: string;
  payload?: unknown;
  seq: number;
  /** True when the event was rendered against a stale document version. */
  stale?: boolean;
}

/** @public The server-authoritative UI state owned by the layer. */
export interface OpenUiSurfaceState {
  /** Materialized document — the mounted tree, tool regions included. */
  document: UiDocument;
  /** Server-side mirror of every `$var` (two-way bindings included). */
  vars: Record<string, unknown>;
  /** Terminal interactions: submits, action runs, `@ToAssistant` sends. */
  interactions: OpenUiInteraction[];
  /** Monotonic version — every mutation (agent render or client event) bumps it. */
  version: number;
  /** Highest id-less client event seq applied — legacy shared watermark. */
  appliedEventSeq: number;
  /**
   * Per-client seq watermarks (`clientId → highest applied seq`). Bounded to
   * `MAX_CLIENT_WATERMARKS` most-recently-active clients.
   */
  clientEventSeqs?: Record<string, number>;
}

function emptyState(dialect: string): OpenUiSurfaceState {
  return {
    document: emptyDocument(dialect),
    vars: {},
    interactions: [],
    version: 0,
    appliedEventSeq: -1,
  };
}

/** Newest interactions kept on the durable state. */
const MAX_INTERACTIONS = 100;
/** Most-recently-active client watermarks kept on the durable state. */
const MAX_CLIENT_WATERMARKS = 32;
/**
 * Largest accepted `set` payload, in JSON bytes. `vars` round-trips through
 * every checkpoint and every recall render — an unbounded client payload is
 * a durable-state and prompt-size hazard.
 */
const MAX_SET_PAYLOAD_BYTES = 16 * 1024;

function trimInteractions(interactions: OpenUiInteraction[]): OpenUiInteraction[] {
  if (interactions.length <= MAX_INTERACTIONS) {
    return interactions;
  }
  return interactions.slice(interactions.length - MAX_INTERACTIONS);
}

/**
 * Insert/refresh one client watermark, evicting the stalest entries past the
 * cap. Re-insertion order approximates recency (object key order).
 */
function bumpClientWatermark(
  watermarks: Record<string, number> | undefined,
  clientId: string,
  seq: number,
): Record<string, number> {
  const entries = Object.entries(watermarks ?? {}).filter(([id]) => id !== clientId);
  entries.push([
    clientId,
    seq,
  ]);
  const kept =
    entries.length <= MAX_CLIENT_WATERMARKS
      ? entries
      : entries.slice(entries.length - MAX_CLIENT_WATERMARKS);
  return Object.fromEntries(kept);
}

/** The dedupe watermark applicable to one event. */
function watermarkFor(state: OpenUiSurfaceState, event: UiEvent): number {
  if (event.clientId !== undefined) {
    return state.clientEventSeqs?.[event.clientId] ?? -1;
  }
  return state.appliedEventSeq;
}

/** Whether a `set` targets a `$var` the current document actually declares. */
function isDeclaredStateVar(state: OpenUiSurfaceState, ref: string): boolean {
  const key = ref.startsWith('$') ? ref : `$${ref}`;
  return state.document.assignments[key] !== undefined;
}

function withinPayloadCap(payload: unknown): boolean {
  if (payload === undefined) {
    return true;
  }
  try {
    const json = JSON.stringify(payload);
    return json === undefined || new TextEncoder().encode(json).byteLength <= MAX_SET_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

//#endregion

//#region Recall rendering

interface SurfaceView {
  root: string | null;
  statements: string[];
  vars: Record<string, unknown>;
  interactions: OpenUiInteraction[];
  version: number;
}

function renderSurface(view: SurfaceView): string {
  return `<ui_surface version="${view.version}">\n${JSON.stringify(
    {
      root: view.root,
      statements: view.statements,
      vars: view.vars,
      interactions: view.interactions,
    },
    null,
    2,
  )}\n</ui_surface>`;
}

function renderWithinBudget(state: OpenUiSurfaceState, budget: number): string {
  let view: SurfaceView = {
    root: state.document.root,
    statements: state.document.order
      .map((ref) => state.document.assignments[ref])
      .filter((a): a is NonNullable<typeof a> => a !== undefined)
      .map(serializeAssignment),
    vars: state.vars,
    interactions: state.interactions,
    version: state.version,
  };
  let text = renderSurface(view);
  // `budget > 0` is the fail-open convention (see instructions / taskState):
  // a zero allocation must not delete the surface from the view.
  if (budget > 0) {
    // Drop the OLDEST interactions first, then halve statements — recent
    // interactions and $vars are what the model most needs.
    while (estimateTokens(text) > budget && view.interactions.length > 0) {
      view = {
        ...view,
        interactions: view.interactions.slice(Math.ceil(view.interactions.length / 2)),
      };
      text = renderSurface(view);
    }
    while (estimateTokens(text) > budget && view.statements.length > 0) {
      view = {
        ...view,
        statements: view.statements.slice(0, Math.floor(view.statements.length / 2)),
      };
      text = renderSurface(view);
    }
    if (estimateTokens(text) > budget) {
      const closing = '\n</ui_surface>';
      const maxChars = Math.max(0, budget * 4 - closing.length);
      text = `${text.slice(0, maxChars)}${closing}`;
    }
  }
  return text;
}

//#endregion

//#region History projection

const SUPERSEDED_PLACEHOLDER = '[rendered ui — superseded; current surface is in <ui_surface>]';
const ASSIGNMENT_LINE_RE = /^\$?[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S/;

function looksLikeOpenUiLang(text: string): boolean {
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return firstLine !== undefined && ASSIGNMENT_LINE_RE.test(firstLine);
}

function isAssistantLangMessage(item: Item): boolean {
  return (
    isAssistantMessage(item) &&
    looksLikeOpenUiLang(
      collectOutputText([
        item,
      ]).join(''),
    )
  );
}

/** Collapse every superseded OpenUI Lang render in history except the newest. */
function collapseSupersededRenders(items: ReadonlyArray<Item>): ReadonlyArray<Item> {
  const lastLangIndex = items.findLastIndex(isAssistantLangMessage);
  if (lastLangIndex === -1) {
    return items;
  }
  return items.map((item, index) => {
    if (index === lastLangIndex || !isAssistantMessage(item) || !isAssistantLangMessage(item)) {
      return item;
    }
    // Replace the text of each output_text part in place, preserving the
    // item's exact shape (annotations, ids, other content parts).
    return {
      ...item,
      content: item.content.map((part) =>
        isOutputText(part)
          ? {
              ...part,
              text: SUPERSEDED_PLACEHOLDER,
            }
          : part,
      ),
    };
  });
}

//#endregion

//#region Layer

/** @public Configuration for `openUiSurface()`. */
export interface OpenUiSurfaceConfig {
  library: UiLibrary;
}

export const OPENUI_SURFACE_LAYER_ID = 'openui-surface';

/**
 * The surface layer plus a live read handle for loop predicates (`Until`
 * receives only a `Snapshot`, so predicates close over the layer instance)
 * and transport snapshots. The mirror is keyed by THREAD: one layer instance
 * on a multi-thread harness keeps an independent mirror per thread, so
 * `readState(threadId)` never serves one thread's surface as another's.
 * @public
 */
export interface OpenUiSurfaceLayer extends ContextLayer<OpenUiSurfaceState> {
  /**
   * Latest state observed by any hook of this layer instance for `threadId`.
   * Omitting the thread returns the most recently ACTIVE thread's state —
   * correct for single-thread harnesses, ambiguous otherwise.
   */
  readState(threadId?: string): OpenUiSurfaceState | undefined;
}

function applyEvents(
  state: OpenUiSurfaceState,
  params: OnItemAppendParams<OpenUiSurfaceState>,
): OnItemAppendResult<OpenUiSurfaceState> {
  const kept: Item[] = [];
  let next = state;
  let applied = false;
  for (const item of params.items) {
    const event = readUiEvent(item);
    if (event === null) {
      kept.push(item);
      continue;
    }
    if (event.seq <= watermarkFor(next, event)) {
      continue; // duplicate delivery (reconnect replay) — already applied
    }
    const advanceWatermarks = (
      s: OpenUiSurfaceState,
    ): Pick<OpenUiSurfaceState, 'appliedEventSeq' | 'clientEventSeqs'> =>
      event.clientId !== undefined
        ? {
            appliedEventSeq: s.appliedEventSeq,
            clientEventSeqs: bumpClientWatermark(s.clientEventSeqs, event.clientId, event.seq),
          }
        : {
            appliedEventSeq: event.seq,
            clientEventSeqs: s.clientEventSeqs,
          };
    const stale = event.version !== undefined && event.version < next.version;
    applied = true;
    if (event.kind === UiEventKind.Set) {
      /* Two-way-binding updates only mirror into vars when the target is a
       * `$var` the document actually declares and the payload is bounded —
       * `vars` rides every checkpoint and recall render, so an arbitrary
       * client must not be able to grow it without limit. Rejected sets
       * still advance the watermark (the event was seen, just refused). */
      const accepted = isDeclaredStateVar(next, event.ref) && withinPayloadCap(event.payload);
      if (!accepted) {
        params.ctx.trace.addEvent('openui.set_rejected', {
          ref: event.ref,
          reason: isDeclaredStateVar(next, event.ref) ? 'payload too large' : 'unknown state var',
        });
      }
      next = {
        ...next,
        ...(accepted
          ? {
              vars: {
                ...next.vars,
                [event.ref]: event.payload,
              },
              version: next.version + 1,
            }
          : {}),
        ...advanceWatermarks(next),
      };
      continue;
    }
    next = {
      ...next,
      interactions: trimInteractions([
        ...next.interactions,
        {
          kind: event.kind,
          ref: event.ref,
          payload: event.payload,
          seq: event.seq,
          ...(stale
            ? {
                stale,
              }
            : {}),
        },
      ]),
      version: next.version + 1,
      ...advanceWatermarks(next),
    };
    kept.push(item);
  }
  return {
    items: kept,
    state: next,
    rerender: applied,
    timing: 'immediate',
  };
}

function foldModelRender(
  state: OpenUiSurfaceState,
  params: AfterModelCallParams<OpenUiSurfaceState>,
  library: UiLibrary,
): AfterModelCallResult<OpenUiSurfaceState> {
  const text = collectOutputText(params.response.items).join('\n');
  if (text.length === 0 || !looksLikeOpenUiLang(text)) {
    return {
      decision: {
        action: 'allow',
      },
    };
  }
  const incoming = parseDocument(text, library.dialect);
  if (incoming.order.length === 0) {
    return {
      decision: {
        action: 'allow',
      },
    };
  }
  const document = mergeDocument(state.document, incoming);
  const issues = validateDocument(library, incoming);
  for (const issue of issues) {
    params.ctx.trace.addEvent('openui.validation', {
      ref: issue.ref,
      component: issue.component,
      message: issue.message,
    });
  }
  return {
    decision:
      issues.length > 0
        ? {
            action: 'guide',
            guidance: `The rendered UI has ${issues.length} problem(s) against the component library: ${issues
              .map((i) => `${i.ref}: ${i.message}`)
              .join('; ')}. Re-render using only registered components and valid props.`,
          }
        : {
            action: 'allow',
          },
    state: {
      ...state,
      document,
      version: state.version + 1,
    },
  };
}

/**
 * Create the server-authoritative UI surface layer for a library.
 * @public
 */
export function openUiSurface(config: OpenUiSurfaceConfig): OpenUiSurfaceLayer {
  const dialect = config.library.dialect;
  /** Per-thread mirrors + the last thread any hook touched (single-thread convenience). */
  const liveByThread = new Map<string, OpenUiSurfaceState>();
  let lastThreadId: string | undefined;
  const observeFor =
    (threadId: string) =>
    (state: OpenUiSurfaceState): OpenUiSurfaceState => {
      liveByThread.set(threadId, state);
      lastThreadId = threadId;
      return state;
    };

  const hooks: ContextLayerHooks<OpenUiSurfaceState> = {
    async init({ storage, ctx }) {
      const saved = await storage.get<OpenUiSurfaceState>('state');
      return {
        state: observeFor(ctx.threadId)(saved ?? emptyState(dialect)),
      };
    },

    async onItemAppend(params) {
      const state = params.state ?? emptyState(dialect);
      const result = applyEvents(state, params);
      if (result.state) {
        observeFor(params.ctx.threadId)(result.state);
      }
      return result;
    },

    async recall({ state, budget }) {
      if (!state || state.version === 0) {
        return null;
      }
      const text = renderWithinBudget(state, budget);
      return {
        items: [
          createMessage(text, 'developer'),
        ],
        tokenCount: estimateTokens(text),
      };
    },

    async projectHistory({ items }) {
      return {
        items: collapseSupersededRenders(items),
      };
    },

    async afterModelCall(params) {
      const state = params.state ?? emptyState(dialect);
      const result = foldModelRender(state, params, config.library);
      if (result.state) {
        observeFor(params.ctx.threadId)(result.state);
      }
      return result;
    },

    async store({ state, ctx }) {
      // Mutations happen in onItemAppend/afterModelCall; returning the state
      // here keeps the runtime's durable write-through mirror current.
      if (!state) {
        return undefined;
      }
      return {
        state: observeFor(ctx.threadId)(state),
      };
    },

    async onSpawn({ parentState }) {
      // Read-only snapshot: a child can see the surface, not own it.
      return {
        childState: structuredClone(parentState),
        items: [],
      };
    },

    async onReturn({ childState, parentState }) {
      // Conservative write direction: the parent owns document + vars; only
      // interactions the child explicitly produced merge back.
      const parent = parentState ?? emptyState(dialect);
      const known = new Set(parent.interactions.map((i) => i.seq));
      const merged: OpenUiSurfaceState = {
        ...parent,
        interactions: trimInteractions([
          ...parent.interactions,
          ...childState.interactions.filter((i) => !known.has(i.seq)),
        ]),
      };
      return {
        parentState: merged,
      };
    },

    async onComplete({ state, ctx }) {
      if (!state) {
        return undefined;
      }
      return {
        state: observeFor(ctx.threadId)(state),
      };
    },
  };

  return {
    id: OPENUI_SURFACE_LAYER_ID,
    name: 'OpenUI Surface',
    slot: Slot.WORKING_MEMORY + 20, // 120
    // 'thread' (not 'execution'): the surface must survive across executions
    // within a thread — reconnect rehydration and resumed runs depend on it.
    scope: 'thread',
    budget: {
      min: 150,
      max: 1200,
    },
    rerenderTiming: 'immediate',
    itemSchemas: {
      developerMessages: [
        UiEventItemSchema,
      ],
    },
    provides: {
      document: {
        kind: 'data',
        read: (state: OpenUiSurfaceState) => state.document,
      },
      vars: {
        kind: 'data',
        read: (state: OpenUiSurfaceState) => state.vars,
      },
      interactions: {
        kind: 'data',
        read: (state: OpenUiSurfaceState) => state.interactions,
      },
      version: {
        kind: 'data',
        read: (state: OpenUiSurfaceState) => state.version,
      },
    },
    hooks,
    readState: (threadId?: string) => {
      const key = threadId ?? lastThreadId;
      return key === undefined ? undefined : liveByThread.get(key);
    },
  };
}

//#endregion
