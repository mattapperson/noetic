/**
 * Child links: how a run remembers the executions it spawned out of process, so a
 * forget of the run finds them (spec 23 § Forgetting).
 *
 * A spawn run in process records its steps under its run's root, so it needs no
 * link. One routed to a subprocess adapter that runs it elsewhere becomes an
 * execution of its own, under its own id; the parent run writes
 * `execution:<rootId>:child:<childId>` before dispatching it.
 */

import type { Context, StorageAdapter, SubprocessAdapter } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { ContextImpl, rootIdOf } from '../context-impl';

//#region In-process adapters

/** Adapters that run a step in the calling process, through its local executor. */
const inProcess = new WeakSet<SubprocessAdapter>();

/** @internal Mark `adapter` as one that runs steps in the calling process. */
export function markInProcess<T extends SubprocessAdapter>(adapter: T): T {
  inProcess.add(adapter);
  return adapter;
}

/** @internal True when `adapter` runs steps in the calling process: its children need no link. */
export function runsInProcess(adapter: SubprocessAdapter): boolean {
  return inProcess.has(adapter);
}

//#endregion

//#region Adapters used

/** The out-of-process adapters each harness has dispatched a child through. */
const usedBy = new WeakMap<object, Set<SubprocessAdapter>>();

/** @internal Note that `harness` dispatched a child through `adapter`. */
export function noteAdapter(harness: object, adapter: SubprocessAdapter): void {
  const used = usedBy.get(harness) ?? new Set<SubprocessAdapter>();
  used.add(adapter);
  usedBy.set(harness, used);
}

/** @internal The out-of-process adapters `harness` has dispatched a child through. */
export function adaptersUsedBy(harness: object): ReadonlyArray<SubprocessAdapter> {
  return [
    ...(usedBy.get(harness) ?? []),
  ];
}

//#endregion

//#region Links

const CHILD_PART = ':child:';

function linkPrefix(rootId: string): string {
  return `execution:${rootId}${CHILD_PART}`;
}

/** @internal Record that the run rooted at `rootId` spawned the execution `childId`. */
export async function linkChild(
  storage: StorageAdapter,
  link: {
    rootId: string;
    childId: string;
    stepId: string;
  },
): Promise<void> {
  await storage.set(`${linkPrefix(link.rootId)}${link.childId}`, {
    stepId: link.stepId,
    at: new Date().toISOString(),
  });
}

//#endregion

//#region Dispatch

/**
 * A step an adapter runs out of process for `parent` is an execution of its own:
 * on a durable run, link it to the run's root so a forget of the run finds it, and
 * note the adapter so the forget can stop it (spec 23 § Forgetting). One run in
 * process records under the root already.
 *
 * @internal
 */
export async function linkIfOutOfProcess<TContext>(
  parent: Context<TContext>,
  adapter: SubprocessAdapter,
  child: {
    childId: string;
    stepId: string;
  },
): Promise<void> {
  if (runsInProcess(adapter) || !(parent instanceof ContextImpl) || parent.ledger === undefined) {
    return;
  }
  const storage = frameworkCast<{
    config?: {
      storage?: StorageAdapter;
    };
  }>(parent.harness).config?.storage;
  if (!storage) {
    return;
  }
  noteAdapter(parent.harness, adapter);
  await linkChild(storage, {
    rootId: rootIdOf(parent),
    ...child,
  });
}

//#endregion
