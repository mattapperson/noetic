/**
 * The nested agents a harness can stop (spec 08 § Nested agents): each one a
 * running turn's agent announced as cancellable, by its scope id, while its
 * turn runs in this process.
 */

/** Stops one nested agent; the turn that runs it goes on. */
type Stop = () => Promise<void>;

const registries = new WeakMap<object, Map<string, Stop>>();

function registryOf(harness: object): Map<string, Stop> {
  let registry = registries.get(harness);
  if (!registry) {
    registry = new Map();
    registries.set(harness, registry);
  }
  return registry;
}

/** Let the harness stop the nested agent `scopeId`; the returned function takes that back. */
export function offerStop(harness: object, scopeId: string, stop: Stop): () => void {
  const registry = registryOf(harness);
  registry.set(scopeId, stop);
  return () => {
    if (registry.get(scopeId) === stop) {
      registry.delete(scopeId);
    }
  };
}

/** Stop the nested agent `scopeId`: false when no running turn here offers to. */
export async function stopNestedAgent(harness: object, scopeId: string): Promise<boolean> {
  const stop = registries.get(harness)?.get(scopeId);
  if (!stop) {
    return false;
  }
  await stop();
  return true;
}
