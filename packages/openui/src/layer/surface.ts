/**
 * The `openUiSurface()` memory layer — the server-authoritative owner of UI
 * state. The client renderer is a projection of this layer's state, never the
 * other way around: agent renders fold in via `afterModelCall`, client events
 * reduce in via `onItemAppend`, the model sees a budget-trimmed `<ui_surface>`
 * block via `recall`, and thread scope + the runtime's durable write-through
 * make the surface survive resume and reconnect.
 */

import type {
  AfterModelCallParams,
  AfterModelCallResult,
  InputMessageItem,
  Item,
  MemoryHooks,
  MemoryLayer,
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
  /** Client-assigned monotonic sequence — dedupe/ordering across reconnects. */
  seq: z.number().int().nonnegative(),
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
  /** Highest client event seq applied — dedupe/ordering on reconnect. */
  appliedEventSeq: number;
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

function trimInteractions(interactions: OpenUiInteraction[]): OpenUiInteraction[] {
  if (interactions.length <= MAX_INTERACTIONS) {
    return interactions;
  }
  return interactions.slice(interactions.length - MAX_INTERACTIONS);
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
  // `budget > 0` is the fail-open convention (see staticContent / durableTaskState):
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
 * receives only a `Snapshot`, so predicates close over the layer instance).
 * The mirror tracks the most recent state any hook observed — per-execution
 * best effort; create one surface per harness when executions run in parallel.
 * @public
 */
export interface OpenUiSurfaceLayer extends MemoryLayer<OpenUiSurfaceState> {
  /** Latest state observed by any hook of this layer instance. */
  readState(): OpenUiSurfaceState | undefined;
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
    if (event.seq <= next.appliedEventSeq) {
      continue; // duplicate delivery (reconnect replay) — already applied
    }
    const stale = event.version !== undefined && event.version < next.version;
    applied = true;
    if (event.kind === UiEventKind.Set) {
      // Keystroke-grade updates mirror into vars but never reach the item log.
      next = {
        ...next,
        vars: {
          ...next.vars,
          [event.ref]: event.payload,
        },
        version: next.version + 1,
        appliedEventSeq: event.seq,
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
      appliedEventSeq: event.seq,
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
  let live: OpenUiSurfaceState | undefined;
  const observe = (state: OpenUiSurfaceState): OpenUiSurfaceState => {
    live = state;
    return state;
  };

  const hooks: MemoryHooks<OpenUiSurfaceState> = {
    async init({ storage }) {
      const saved = await storage.get<OpenUiSurfaceState>('state');
      return {
        state: observe(saved ?? emptyState(dialect)),
      };
    },

    async onItemAppend(params) {
      const state = params.state ?? emptyState(dialect);
      const result = applyEvents(state, params);
      if (result.state) {
        observe(result.state);
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
        observe(result.state);
      }
      return result;
    },

    async store({ state }) {
      // Mutations happen in onItemAppend/afterModelCall; returning the state
      // here keeps the runtime's durable write-through mirror current.
      if (!state) {
        return undefined;
      }
      return {
        state: observe(state),
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
        parentState: observe(merged),
      };
    },

    async onComplete({ state }) {
      if (!state) {
        return undefined;
      }
      return {
        state: observe(state),
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
    readState: () => live,
  };
}

//#endregion
