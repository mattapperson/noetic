/**
 * Abort-aware wrapper for async iterables.
 *
 * The harness's broadcast streams never complete on session abort, so a
 * `for await` over them can stay parked forever holding stale closures.
 * `abortableIterable` races each `next()` against an AbortSignal:
 *
 * - On abort, iteration ends cleanly (the abort is swallowed, NOT rethrown)
 *   and the inner iterator's `return()` is invoked so broadcast iterators
 *   unhook their waiters.
 * - Real errors from the inner iterator are rethrown to the consumer.
 * - An already-aborted signal yields nothing.
 */

const ABORTED: unique symbol = Symbol('abortable-iterable.aborted');

export async function* abortableIterable<T>(
  iterable: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T, void, undefined> {
  const iterator = iterable[Symbol.asyncIterator]();
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, {
      once: true,
    });
  });
  try {
    if (signal.aborted) {
      return;
    }
    while (true) {
      const next = iterator.next();
      const result = await Promise.race([
        next,
        aborted,
      ]);
      if (result === ABORTED) {
        // The abandoned next() may still reject later (e.g. when return()
        // tears the stream down) — keep that from becoming an unhandled
        // rejection.
        next.catch(() => {});
        return;
      }
      if (result.done) {
        return;
      }
      yield result.value;
    }
  } finally {
    if (onAbort !== null) {
      signal.removeEventListener('abort', onAbort);
    }
    // Always unhook the inner iterator — on abort, on early consumer break,
    // and on error — so parked broadcast waiters are settled.
    if (iterator.return) {
      await Promise.resolve(iterator.return()).catch(() => {});
    }
  }
}
