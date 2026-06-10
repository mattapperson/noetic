/**
 * Binary pass/fail gate for judge scores. With a threshold configured, a raw
 * score at or above it maps to 1 and anything below maps to 0; without one,
 * the raw score passes through unchanged. Callers preserve the raw judge
 * score in `metadata.rawScore`.
 */
export function applyThreshold(raw: number, threshold: number | undefined): number {
  if (threshold === undefined) {
    return raw;
  }
  return raw >= threshold ? 1 : 0;
}
