/**
 * Child links: how a run remembers the executions it had a subprocess adapter run
 * out of process, so a forget of the run finds them and stops one still running
 * (spec 23 § Forgetting).
 *
 * A spawn run in process records its steps under its run's root, so it needs no
 * link. One an adapter runs elsewhere becomes an execution of its own, under its
 * own id: the parent run writes `execution:<rootId>:child:<childId>` before
 * dispatching it, naming the step and where its adapter came from, and marks the
 * link `settled` once the child has finished.
 */

import type {
  Context,
  SpawnedSubprocess,
  StorageAdapter,
  SubprocessAdapter,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
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

/** The adapter each child a harness dispatched out of process ran on, by child id. */
const ranBy = new WeakMap<object, Map<string, SubprocessAdapter>>();

function noteAdapter(harness: object, childId: string, adapter: SubprocessAdapter): void {
  const children = ranBy.get(harness) ?? new Map<string, SubprocessAdapter>();
  children.set(childId, adapter);
  ranBy.set(harness, children);
}

/** @internal The out-of-process adapters `harness` has dispatched a child through. */
export function adaptersUsedBy(harness: object): ReadonlyArray<SubprocessAdapter> {
  return [
    ...new Set(ranBy.get(harness)?.values()),
  ];
}

/** @internal The adapter `harness` dispatched the child `childId` through, when it did. */
export function adapterOfChild(harness: object, childId: string): SubprocessAdapter | undefined {
  return ranBy.get(harness)?.get(childId);
}

//#endregion

//#region Links

/** @internal Where the adapter that ran a child came from. */
export const ChildAdapterSource = {
  /** The harness's `environment.subprocess`. */
  Harness: 'harness',
  /** The step's own `subprocess`. */
  Step: 'step',
  /** The `subprocess` a `detachedSpawn` call passed. */
  Call: 'call',
} as const;

/** @internal */
export type ChildAdapterSource = (typeof ChildAdapterSource)[keyof typeof ChildAdapterSource];

/** @internal A child link as stored. */
export const ChildLinkSchema = z.object({
  stepId: z.string(),
  at: z.string(),
  from: z.enum([
    ChildAdapterSource.Harness,
    ChildAdapterSource.Step,
    ChildAdapterSource.Call,
  ]),
  /** Set once the child finished, however it ended. */
  settled: z.boolean().optional(),
});

/** @internal */
export type ChildLink = z.infer<typeof ChildLinkSchema>;

/** @internal The key of the link from the run rooted at `rootId` to `childId`. */
export function childLinkKey(rootId: string, childId: string): string {
  return `execution:${rootId}:child:${childId}`;
}

/** Mark a link settled, unless a forget deleted it meanwhile: nothing brings it back. */
async function markSettled(storage: StorageAdapter, key: string): Promise<void> {
  const raw = await storage.get<unknown>(key);
  const link = ChildLinkSchema.safeParse(raw);
  if (!link.success || link.data.settled) {
    return;
  }
  const next: ChildLink = {
    ...link.data,
    settled: true,
  };
  if (storage.swap) {
    await storage.swap(key, raw, next);
    return;
  }
  await storage.set(key, next);
}

//#endregion

//#region Dispatch

/** The durable storage of `parent`'s run, when it has a ledger: only then is a child linked. */
function durableStorageOf<TContext>(parent: Context<TContext>): StorageAdapter | undefined {
  if (!(parent instanceof ContextImpl) || parent.ledger === undefined) {
    return undefined;
  }
  return frameworkCast<{
    config?: {
      storage?: StorageAdapter;
    };
  }>(parent.harness).config?.storage;
}

/**
 * Dispatch a step to `adapter` for `parent`. A step the adapter runs out of process
 * is an execution of its own: on a durable run it is linked to the run's root before
 * it is dispatched, and the link is marked settled once the child finished (spec 23
 * § Forgetting).
 *
 * @internal
 */
export async function spawnLinked<TContext>(
  parent: Context<TContext>,
  adapter: SubprocessAdapter,
  child: {
    childId: string;
    stepId: string;
    from: ChildAdapterSource;
    spawn: () => Promise<SpawnedSubprocess>;
  },
): Promise<SpawnedSubprocess> {
  const storage = runsInProcess(adapter) ? undefined : durableStorageOf(parent);
  if (!storage) {
    return child.spawn();
  }
  noteAdapter(parent.harness, child.childId, adapter);
  const key = childLinkKey(rootIdOf(frameworkCast<Context>(parent)), child.childId);
  const link: ChildLink = {
    stepId: child.stepId,
    at: new Date().toISOString(),
    from: child.from,
  };
  await storage.set(key, link);
  const spawned = await child.spawn();
  void spawned.settled
    .catch(() => undefined)
    .then(() => markSettled(storage, key))
    .catch(() => undefined);
  return spawned;
}

//#endregion
