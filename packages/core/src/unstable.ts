/**
 * @unstable
 * Unstable exports for framework extenders.
 *
 * Symbols exported from this module may change in any minor release.
 * They are intended for authors of custom memory layers, runtime backends,
 * and other framework extensions. Do not depend on them in application code.
 */

/** @unstable Budget allocation algorithm for memory layer token budgets. */
/** @unstable Layer state store type for managing per-layer state during execution. */
export type { BudgetAllocation, BudgetLimits, LayerStateStore } from '@noetic-tools/memory';
/** @unstable Budget allocation and checking utilities. */
/** @unstable Factory for creating layer state stores. */
/** @unstable View assembly algorithm that converges memory layer outputs into the LLM context. */
/** @unstable Factory for creating scoped storage wrappers around a StorageAdapter. */
export {
  allocateBudgets,
  assembleView,
  checkBudget,
  createLayerStateStore,
  createScopedStorage,
} from '@noetic-tools/memory';
/** @unstable Unsafe cast utility for bridging internal type boundaries. */
export { frameworkCast } from '@noetic-tools/types';
/**
 * @unstable Internal helper used by sync agent-spawn paths (worktree isolation)
 * to seed a child's cwd snapshot without touching `previousCwd`. Not part of
 * the public surface — call sites must hold exclusive use of the parent ctx.
 */
export { retargetCwdForSpawn } from './runtime/cwd-helpers';
