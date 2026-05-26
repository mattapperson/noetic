/**
 * @unstable
 * Unstable exports for framework extenders.
 *
 * Symbols exported from this module may change in any minor release.
 * They are intended for authors of custom memory layers, runtime backends,
 * and other framework extensions. Do not depend on them in application code.
 */

/** @unstable Budget allocation algorithm for memory layer token budgets. */
export type { BudgetAllocation, BudgetLimits } from './memory/budget';
/** @unstable Budget allocation and checking utilities. */
export { allocateBudgets, checkBudget } from './memory/budget';
/** @unstable Layer state store type for managing per-layer state during execution. */
export type { LayerStateStore } from './memory/layer-lifecycle';
/** @unstable Factory for creating layer state stores. */
export { createLayerStateStore } from './memory/layer-lifecycle';
/** @unstable View assembly algorithm that converges memory layer outputs into the LLM context. */
export { assembleView } from './memory/projector';
/** @unstable Factory for creating scoped storage wrappers around a StorageAdapter. */
export { createScopedStorage } from './memory/scope';
/**
 * @unstable Internal helper used by sync agent-spawn paths (worktree isolation)
 * to seed a child's cwd snapshot without touching `previousCwd`. Not part of
 * the public surface — call sites must hold exclusive use of the parent ctx.
 */
export { retargetCwdForSpawn } from './runtime/cwd-helpers';
/** @unstable Unsafe cast utility for bridging internal type boundaries. */
export { frameworkCast } from './util/framework-cast';
