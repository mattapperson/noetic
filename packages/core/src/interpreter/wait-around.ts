import type { NoeticErrorImpl, Step, StorageAdapter } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import type { ContextImpl } from '../runtime/context-impl';
import { isBeneath } from '../runtime/durable/parking';
import { StepIntent } from '../runtime/durable/step-intent';
import type { StepLedger } from '../runtime/durable/step-ledger';
import { pendingEntryKey, runRootOf } from './connection-steps';

interface Guard {
  path: string;
  storage: StorageAdapter;
  slots: Set<string>;
  replayed: Set<string>;
  unknown(): NoeticErrorImpl;
}

const guards = new WeakMap<StepLedger, Map<string, Guard>>();

/** Pin descendants while a durable wait runs its actions. */
export function guardAround(
  ctx: ContextImpl,
  unknown: Guard['unknown'],
):
  | {
      check(): Promise<void>;
      stop(): void;
    }
  | undefined {
  const { ledger } = ctx;
  const storage = frameworkCast<{
    storage?: StorageAdapter;
  }>(ctx.harness.config).storage;
  const path = ctx.currentDispatch()?.path;
  if (!ledger || !storage || path === undefined) {
    return undefined;
  }
  const active = guards.get(ledger) ?? new Map<string, Guard>();
  guards.set(ledger, active);
  const guard: Guard = {
    path,
    storage,
    slots: new Set(),
    replayed: new Set(),
    unknown,
  };
  active.set(path, guard);
  return {
    check: () => checkSlots(guard, pendingEntryKey(runRootOf(ctx).id, path)),
    stop: () => active.delete(path),
  };
}

/** Pin the ID, key, and input at the same child slot, even for dynamically built steps. */
export function pinAroundStep(
  ctx: ContextImpl,
  key: string | undefined,
  kind: Step['kind'],
): Promise<void> | undefined {
  const { ledger } = ctx;
  const active = ledger && guards.get(ledger);
  if (!ledger || !active?.size) {
    return;
  }
  const dispatch = ctx.currentDispatch();
  if (!dispatch) {
    return;
  }
  const parents = [
    ...active.values(),
  ].filter(({ path }) => isBeneath(dispatch.path, path));
  const guard = parents[0];
  if (!guard) {
    return;
  }
  const slot = ctx.dispatchSlot();
  if (slot === undefined || dispatch.inputHash === undefined) {
    return Promise.reject(guard.unknown());
  }
  const storageKey = pendingEntryKey(runRootOf(ctx).id, slot);
  const intent = new StepIntent(guard.storage, storageKey, ledger);
  return pin(
    intent,
    {
      path: dispatch.path,
      key: key ?? null,
      inputHash: dispatch.inputHash,
      kind,
    },
    guard.unknown,
  ).then(() => {
    for (const parent of parents) {
      parent.slots.add(storageKey);
    }
  });
}

/** A replayed parent accounts for its children without dispatching them again. */
export function replayAroundStep(ctx: ContextImpl): void {
  const active = ctx.ledger && guards.get(ctx.ledger);
  if (!active?.size) {
    return;
  }
  const path = ctx.currentPath();
  for (const guard of active.values()) {
    if (isBeneath(path, guard.path)) {
      guard.replayed.add(path);
    }
  }
}

async function checkSlots(guard: Guard, prefix: string): Promise<void> {
  for (const key of await guard.storage.list(prefix)) {
    if (!isBeneath(key, prefix) || !/\/wait-child:\d+$/.test(key) || guard.slots.has(key)) {
      continue;
    }
    const saved = await new StepIntent(guard.storage, key).read();
    const path = saved && typeof saved === 'object' ? Reflect.get(saved, 'path') : undefined;
    if (
      typeof path !== 'string' ||
      ![
        ...guard.replayed,
      ].some((parent) => isBeneath(path, parent))
    ) {
      throw guard.unknown();
    }
  }
}

async function pin(
  intent: StepIntent,
  dispatch: {
    path: string;
    key: string | null;
    inputHash: string;
    kind: Step['kind'];
  },
  unknown: Guard['unknown'],
): Promise<void> {
  const saved = await intent.read();
  if (saved === null) {
    await intent.write(dispatch);
  } else if (
    typeof saved !== 'object' ||
    dispatch.key === null ||
    Reflect.get(saved, 'path') !== dispatch.path ||
    Reflect.get(saved, 'key') !== dispatch.key ||
    Reflect.get(saved, 'kind') !== dispatch.kind ||
    Reflect.get(saved, 'inputHash') !== dispatch.inputHash
  ) {
    throw unknown();
  }
}
