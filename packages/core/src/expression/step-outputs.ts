/**
 * The `$steps` binding's store (spec 33 § The Input): the outputs of workflow
 * nodes that have completed in the enclosing workflow, by node id.
 *
 * One store per run and per hydrated document: keyed on the run's root context,
 * so concurrent runs of the same document never read each other's outputs, and
 * on the document, so two documents run in one run (a model writing and running
 * two `dynamicWorkflow` documents) never read each other's node ids. Spawned and
 * parallel children share their root's store.
 */

import type { Context } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { readInput } from './jsonata';

//#region State

/** Run → document scope → node id → output. */
const stores = new WeakMap<object, WeakMap<object, Map<string, unknown>>>();

/** Steps whose outputs are recorded — those hydrated from a JSON workflow — and the document each belongs to. */
const recorded = new WeakMap<object, object>();

//#endregion

//#region Helpers

/** The topmost ancestor of `ctx`: the run's root context. */
function rootOf(ctx: Context): Context {
  let current: Context = ctx;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}

/**
 * A key that stays the same for every view of the run's root context. Steps run
 * on lanes — proxies over their context — so the context object itself differs
 * per step; its abort signal does not.
 */
function runKey(ctx: Context): object {
  const root = rootOf(ctx);
  return (
    frameworkCast<{
      abortSignal?: AbortSignal;
    }>(root).abortSignal ?? root
  );
}

function storeOf(ctx: Context, scope: object): Map<string, unknown> {
  const key = runKey(ctx);
  const byScope = stores.get(key) ?? new WeakMap<object, Map<string, unknown>>();
  stores.set(key, byScope);
  const existing = byScope.get(scope);
  if (existing) {
    return existing;
  }
  const created = new Map<string, unknown>();
  byScope.set(scope, created);
  return created;
}

//#endregion

//#region Public API

/**
 * Marks a step so the interpreter records its output for `$steps` when it
 * completes, in the store of the document `scope` stands for.
 */
export function markRecorded(step: object, scope: object): void {
  recorded.set(step, scope);
}

/** The document scope a step's output is recorded under, when the interpreter records it for `$steps`. */
export function recordedScopeOf(step: object): object | undefined {
  return recorded.get(step);
}

/** Records a completed node's output under its id for later `$steps` reads in its document. A later run of the same id replaces it. */
export function recordStepOutput(
  ctx: Context,
  node: {
    readonly scope: object;
    readonly id: string;
  },
  output: unknown,
): void {
  storeOf(ctx, node.scope).set(node.id, output);
}

/** The `$steps` value for an expression of document `scope` evaluated in `ctx`: its recorded outputs, read by `readInput`. */
export function stepOutputsOf(ctx: Context, scope: object): Readonly<Record<string, unknown>> {
  const store = stores.get(runKey(ctx))?.get(scope);
  if (!store) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [id, output] of store) {
    out[id] = readInput(output);
  }
  return out;
}

//#endregion
