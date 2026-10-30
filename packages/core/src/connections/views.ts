/**
 * Connection views (spec 35 § Looking, spec 12 § Connection views). Every
 * connection whose profile names state worth reading gets a context layer,
 * added automatically, that renders it within its own budget. Each read is
 * shown on its `look` mode — the harness entry's `look` overrides the
 * profile's default:
 *
 * - `'turn'`: read every turn (cheap summaries).
 * - `'effect'`: read after an operation that changed the connection.
 * - `'ask'`: only when the model asks, through `<name>_call({ read })`.
 *
 * Repeated reads render as diffs against what the model last saw, blob
 * references render as a short reference (sensitive ones are withheld), and
 * each read's token cost is recorded on the trace.
 */

import type { ContextLayer, ExecutionContext, LookMode, RecallResult } from '@noetic-tools/types';
import { createMessage, estimateTokens, isBlobRef, Slot } from '@noetic-tools/types';
import type { ConnectionRuntime } from './registry';
import { mapDeep } from './values';

//#region Types

/** A view layer's state: what the model last saw of each read, and the effect count it saw it at. */
export interface ConnectionViewState {
  readonly previous: Readonly<Record<string, string>>;
  readonly effects: number;
}

interface RenderedRead {
  readonly name: string;
  readonly full: string;
  readonly shown: string;
}

//#endregion

//#region Helpers

const EMPTY_STATE: ConnectionViewState = {
  previous: {},
  effects: -1,
};

/** Approximate characters per token, for trimming to budget. */
const CHARS_PER_TOKEN = 4;

function renderValue(value: unknown): string {
  const withBlobs = mapDeep(value, (node) =>
    isBlobRef(node.value)
      ? {
          replace: `[${node.value.$blob.mimeType} ${node.value.$blob.bytes} bytes: ${node.value.$blob.uri}]`,
        }
      : undefined,
  );
  return typeof withBlobs === 'string' ? withBlobs : JSON.stringify(withBlobs, null, 2);
}

/** A line diff: unchanged lines are left out; removed lines start `- `, added ones `+ `. */
export function lineDiff(before: string, after: string): string {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const removed = oldLines.filter((line) => !newSet.has(line)).map((line) => `- ${line}`);
  const added = newLines.filter((line) => !oldSet.has(line)).map((line) => `+ ${line}`);
  return [
    ...removed,
    ...added,
  ].join('\n');
}

function shownText(full: string, previous: string | undefined): string {
  if (previous === undefined) {
    return full;
  }
  if (previous === full) {
    return '(unchanged)';
  }
  const diff = lineDiff(previous, full);
  return diff.length < full.length ? `(changes)\n${diff}` : full;
}

/** The look mode of a read: the harness entry's `look`, else the profile's, else `'ask'`. */
function modeOf(
  look: Readonly<Record<string, LookMode>> | undefined,
  read: string,
  fallback: LookMode | undefined,
): LookMode {
  return look?.[read] ?? fallback ?? 'ask';
}

/** `'effect'` reads come only after an operation changed the connection (spec 35 § Looking). */
function wantsRead(mode: LookMode, effectsChanged: boolean, effects: number): boolean {
  if (mode === 'turn') {
    return true;
  }
  if (mode === 'effect') {
    return effectsChanged && effects > 0;
  }
  return false;
}

async function readOne(
  runtime: ConnectionRuntime,
  request: {
    readonly name: string;
    readonly read: string;
    readonly ctx: ExecutionContext;
  },
): Promise<string> {
  try {
    const resolved = await runtime.resolve({
      name: request.name,
      scope: {
        executionId: request.ctx.executionId,
        threadId: request.ctx.threadId,
        scopeKey: request.ctx.executionId,
        signal: new AbortController().signal,
      },
    });
    const value = await resolved.read(request.read, {
      signal: new AbortController().signal,
    });
    return renderValue(await runtime.withholdSensitive(value));
  } catch (e) {
    return `(read failed: ${e instanceof Error ? e.message : String(e)})`;
  }
}

//#endregion

//#region Public API

/**
 * The view layer for one connection. It renders nothing while the connection
 * is not ready or has no `'turn'`/`'effect'` reads.
 */
export function connectionViewLayer(
  runtime: ConnectionRuntime,
  name: string,
): ContextLayer<ConnectionViewState> {
  return {
    id: `noetic/connection-view/${name}`,
    name: `connection view: ${name}`,
    slot: Slot.OBSERVATIONS,
    scope: 'execution',
    budget: 'auto',
    placement: 'live',
    onInitError: 'disable',
    hooks: {
      async init() {
        return {
          state: EMPTY_STATE,
        };
      },
      async recall({ state, budget, ctx }): Promise<RecallResult<ConnectionViewState> | null> {
        const current = state ?? EMPTY_STATE;
        const manifest = runtime.current(name)?.manifest;
        if (!manifest) {
          return null;
        }
        const effects = runtime.effectCount(name);
        const effectsChanged = effects !== current.effects;
        const rendered: RenderedRead[] = [];
        for (const resource of Object.values(manifest.resources)) {
          const mode = modeOf(runtime.config(name)?.look, resource.name, resource.look);
          const previous = current.previous[resource.name];
          if (!wantsRead(mode, effectsChanged, effects)) {
            continue;
          }
          const full = await readOne(runtime, {
            name,
            read: resource.name,
            ctx,
          });
          ctx.trace.addEvent('connection.read', {
            connection: name,
            read: resource.name,
            tokens: estimateTokens(full),
          });
          rendered.push({
            name: resource.name,
            full,
            shown: shownText(full, previous),
          });
        }
        if (rendered.length === 0) {
          return null;
        }
        const body = rendered.map((r) => `<read name="${r.name}">\n${r.shown}\n</read>`).join('\n');
        const limit = Math.max(256, budget * CHARS_PER_TOKEN);
        const text = `<connection name="${name}">\n${body.length > limit ? `${body.slice(0, limit)}\n…(truncated)` : body}\n</connection>`;
        const previous: Record<string, string> = {
          ...current.previous,
        };
        for (const r of rendered) {
          previous[r.name] = r.full;
        }
        return {
          items: [
            createMessage(text, 'developer'),
          ],
          tokenCount: estimateTokens(text),
          state: {
            previous,
            effects,
          },
        };
      },
    },
  };
}

/** A view layer for every non-pool connection in `runtime`. */
export function connectionViewLayers(
  runtime: ConnectionRuntime,
): ContextLayer<ConnectionViewState>[] {
  return runtime
    .names()
    .filter((name) => !runtime.config(name)?.pool)
    .map((name) => connectionViewLayer(runtime, name));
}

//#endregion
