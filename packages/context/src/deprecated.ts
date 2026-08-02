/**
 * Deprecated aliases from the "memory layer" era of the framework.
 *
 * The layer system assembles the model's *context window* — recall, budget
 * allocation, history projection, the item-append pipeline — so it is named
 * after context, not memory. Every name below still resolves to its
 * replacement; nothing here changes behaviour.
 *
 * These are scheduled for removal in the next major of `@noetic-tools/context`.
 */

// The contract-level aliases live in @noetic-tools/types. Re-export them so
// this package stays the one-stop import it was before the rename — the
// non-deprecated contract arrives via `@noetic-tools/types/contract`, which
// deliberately does not carry them.
export type {
  ContextMemory,
  InferMemory,
  InferMemoryShape,
  MemoryCallModelRequest,
  MemoryConfig,
  MemoryHooks,
  MemoryLayer,
  MemoryScope,
  ToolMemory,
  ToolMemoryDeclaration,
} from '@noetic-tools/types';
export {
  /** @deprecated Renamed to `buildContextData`. */
  buildContextData as buildContextMemory,
} from './context/layer-api';
export {
  /** @deprecated Renamed to `observationalContext`. */
  observationalContext as observationalMemory,
} from './context/layers/observational-context';
export {
  /** @deprecated Renamed to `planContext`. */
  planContext as planMemory,
} from './context/layers/plan-context';
export {
  /** @deprecated Renamed to `temporalContext`. */
  temporalContext as temporalMemory,
} from './context/layers/temporal-context';
export {
  /** @deprecated Renamed to `toolContextLayer`. */
  toolContextLayer as toolMemoryLayer,
} from './context/layers/tool-context-layer';
export {
  /** @deprecated Renamed to `workingMemoryContext`. */
  workingMemoryContext as workingMemory,
} from './context/layers/working-memory-context';

import type { ObservationalContextConfig } from './context/layers/observational-context';
import type { PlanContextConfig } from './context/layers/plan-context';
import type { TemporalContextConfig } from './context/layers/temporal-context';
import type {
  WorkingMemoryContextConfig,
  WorkingMemoryContextState,
} from './context/layers/working-memory-context';

/** @deprecated Renamed to {@link WorkingMemoryContextConfig}. */
export type WorkingMemoryConfig = WorkingMemoryContextConfig;

/** @deprecated Renamed to {@link WorkingMemoryContextState}. */
export type WorkingMemoryState = WorkingMemoryContextState;

/** @deprecated Renamed to {@link ObservationalContextConfig}. */
export type ObservationalMemoryConfig = ObservationalContextConfig;

/** @deprecated Renamed to {@link TemporalContextConfig}. */
export type TemporalMemoryConfig = TemporalContextConfig;

/** @deprecated Renamed to {@link PlanContextConfig}. */
export type PlanMemoryConfig = PlanContextConfig;
