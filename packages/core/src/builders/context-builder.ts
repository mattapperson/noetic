import type { ContextConfig, ContextLayer } from '@noetic-tools/context';
import { frameworkCast } from '@noetic-tools/types';

/**
 * Creates a type-safe context configuration from a tuple of context layers.
 * The returned config preserves literal layer types for compile-time inference
 * via `InferContext<typeof config>`.
 *
 * @public
 * @param layers - Tuple of context layers to include in the configuration.
 * @returns A `ContextConfig` carrying the inferred context shape as a phantom type.
 */
export function context<const T extends readonly ContextLayer[]>(layers: T): ContextConfig<T> {
  return frameworkCast<ContextConfig<T>>({
    layers,
  });
}
