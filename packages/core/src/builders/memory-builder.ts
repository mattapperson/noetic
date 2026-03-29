import { frameworkCast } from '../interpreter/framework-cast';
import type { MemoryConfig, MemoryLayer } from '../types/memory';

/**
 * Creates a type-safe memory configuration from a tuple of memory layers.
 * The returned config preserves literal layer types for compile-time inference
 * via `InferMemory<typeof config>`.
 *
 * @public
 * @param layers - Tuple of memory layers to include in the configuration.
 * @returns A `MemoryConfig` carrying the inferred memory shape as a phantom type.
 */
export function memory<const T extends readonly MemoryLayer[]>(layers: T): MemoryConfig<T> {
  return frameworkCast<MemoryConfig<T>>({
    layers,
  });
}
