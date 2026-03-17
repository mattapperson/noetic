/**
 * Explicit cast for framework boundaries where TypeScript's type system
 * cannot express the relationship between input and output types.
 *
 * Used for: pass-through returns (branch null route, loop feedback),
 * raw LLM text output, type-erased collections, and cross-library bridges.
 *
 * This is the single approved location for unsafe type coercion in the codebase.
 */

// Declared return type differs from the parameter type intentionally —
// callers specify T to bridge a framework type gap that TypeScript cannot express.
// The runtime value is returned unchanged (identity function).
export function frameworkCast<T>(value: unknown): T {
  // @ts-expect-error — intentional unsafe coercion at framework boundary
  return value;
}
