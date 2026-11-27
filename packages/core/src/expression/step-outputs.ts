/**
 * The store behind the `$steps` and `$runs` bindings (spec 33 § The Input): the
 * outputs of workflow nodes that have completed in the enclosing workflow, and
 * how many times each loop's body has run, by node id.
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

/** What one document has recorded in one run, each by node id. */
interface Store {
  readonly outputs: Map<string, unknown>;
  readonly runs: Map<string, number>;
}

/** Run → document scope → what it recorded. */
const stores = new WeakMap<object, WeakMap<object, Store>>();

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

function storeOf(ctx: Context, scope: object): Store {
  const key = runKey(ctx);
  const byScope = stores.get(key) ?? new WeakMap<object, Store>();
  stores.set(key, byScope);
  const existing = byScope.get(scope);
  if (existing) {
    return existing;
  }
  const created: Store = {
    outputs: new Map(),
    runs: new Map(),
  };
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
  storeOf(ctx, node.scope).outputs.set(node.id, output);
}

/**
 * Records how many times the body of a workflow `loop` node has run in its
 * current run, for `$runs`. A step that no JSON workflow hydrated records nothing.
 */
export function recordLoopRuns(
  ctx: Context,
  loop: {
    readonly id: string;
  },
  runs: number,
): void {
  const scope = recorded.get(loop);
  if (scope) {
    storeOf(ctx, scope).runs.set(loop.id, runs);
  }
}

/** The `$steps` value for an expression of document `scope` evaluated in `ctx`: its recorded outputs, read by `readInput`. */
export function stepOutputsOf(ctx: Context, scope: object): Readonly<Record<string, unknown>> {
  const store = stores.get(runKey(ctx))?.get(scope);
  if (!store) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [id, output] of store.outputs) {
    out[id] = readInput(output);
  }
  return out;
}

/** How many times the body of workflow `loop` node `loop` has run, when it is one and has started. */
export function loopRuns(
  ctx: Context,
  loop: {
    readonly id: string;
  },
): number | undefined {
  const scope = recorded.get(loop);
  return scope ? stores.get(runKey(ctx))?.get(scope)?.runs.get(loop.id) : undefined;
}

/** The `$runs` value for an expression of document `scope` evaluated in `ctx`: body runs by loop node id. */
export function loopRunsOf(ctx: Context, scope: object): Readonly<Record<string, number>> {
  return Object.fromEntries(stores.get(runKey(ctx))?.get(scope)?.runs ?? []);
}

//#endregion
