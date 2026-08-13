/**
 * Bounded worker pool preserving result order (same shape as core's
 * runWithConcurrency). Shared by the suite runner (per-case concurrency)
 * and the GEPA bridge (per-field teacher proposals).
 */
export async function runPool<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive integer');
  }
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      const task = tasks[index];
      results[index] = await task();
    }
  }
  await Promise.all(
    Array.from(
      {
        length: Math.max(1, Math.min(concurrency, tasks.length)),
      },
      () => worker(),
    ),
  );
  return results;
}
