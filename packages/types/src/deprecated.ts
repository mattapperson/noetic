/**
 * Deprecated aliases from the "memory layer" era of the framework.
 *
 * The layer system assembles the model's *context window* — recall, budget
 * allocation, history projection, the item-append pipeline — so it is named
 * after context, not memory. Every name below still resolves to its
 * replacement; nothing here changes behaviour.
 *
 * These are scheduled for removal in the next major of `@noetic-tools/types`.
 */
import type {
  ContextConfig,
  ContextData,
  ContextLayer,
  ContextLayerHooks,
  InferContext,
  InferContextShape,
} from './types/context-layer';
import type { ContextScope, LayerCallModelRequest } from './types/context-scope';
import type { LayerTraceSpan } from './types/observability';
import type { ToolContextDeclaration } from './types/tool';
import type { ToolContext } from './types/tool-context';

/** @public @deprecated Renamed to {@link ContextLayer}. */
export type MemoryLayer<TState = unknown> = ContextLayer<TState>;

/** @public @deprecated Renamed to {@link ContextLayerHooks}. */
export type MemoryHooks<TState = unknown> = ContextLayerHooks<TState>;

/** @public @deprecated Renamed to {@link ContextConfig}. */
export type MemoryConfig<TLayers extends readonly ContextLayer[] = readonly ContextLayer[]> =
  ContextConfig<TLayers>;

/** @public @deprecated Renamed to {@link ContextData}. */
export type ContextMemory = ContextData;

/** @public @deprecated Renamed to {@link InferContext}. */
export type InferMemory<
  T extends {
    readonly _shape: unknown;
  },
> = InferContext<T>;

/** @public @deprecated Renamed to {@link InferContextShape}. */
export type InferMemoryShape<T extends readonly ContextLayer[]> = InferContextShape<T>;

/** @public @deprecated Renamed to {@link ContextScope}. */
export type MemoryScope = ContextScope;

/** @public @deprecated Renamed to {@link LayerCallModelRequest}. */
export type MemoryCallModelRequest = LayerCallModelRequest;

/** @public @deprecated Renamed to {@link LayerTraceSpan}. */
export type MemoryTraceSpan = LayerTraceSpan;

/** @public @deprecated Renamed to {@link ToolContext}. */
export type ToolMemory = ToolContext;

/** @public @deprecated Renamed to {@link ToolContextDeclaration}. */
export type ToolMemoryDeclaration<TState = unknown> = ToolContextDeclaration<TState>;
