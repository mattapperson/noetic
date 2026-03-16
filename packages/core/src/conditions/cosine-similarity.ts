/**
 * Cosine similarity between two vectors.
 * Returns a value in [-1, 1]. Throws on dimension mismatch.
 * Returns 0 for zero-magnitude vectors.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA * normB);
  if (magnitude === 0) {
    return 0;
  }

  return dot / magnitude;
}
