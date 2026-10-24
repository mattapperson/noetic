import type { Snapshot, Until, Verdict } from '@noetic-tools/types';

/**
 * Combines predicates with OR semantics; stops the loop when any predicate says stop.
 *
 * Predicates run in order and the first stop verdict short-circuits, so it is
 * returned as is. When none stops, the combined verdict carries every
 * predicate's `reason` (joined with `'; '`) and `feedback` (joined with `'\n'`),
 * so a failing `until.verified()` still hands its feedback to `prepareNext`.
 *
 * @public
 * @param predicates - Until predicates to evaluate.
 * @returns A combined `Until` that short-circuits on the first stop verdict.
 */
export function any(...predicates: Until[]): Until {
  return async (snapshot: Snapshot): Promise<Verdict> => {
    const verdicts: Verdict[] = [];
    for (const pred of predicates) {
      const verdict = await pred(snapshot);
      if (verdict.stop) {
        return verdict;
      }
      verdicts.push(verdict);
    }
    return merge(false, verdicts);
  };
}

/**
 * Combines predicates with AND semantics; stops the loop only when all predicates say stop.
 *
 * Predicates run in order and the first continue verdict short-circuits, so it
 * is returned as is. When all stop, the combined verdict carries every
 * predicate's `reason` (joined with `'; '`, default `'All predicates
 * satisfied'`) and `feedback` (joined with `'\n'`).
 *
 * @public
 * @param predicates - Until predicates to evaluate.
 * @returns A combined `Until` that requires all predicates to be satisfied.
 */
export function all(...predicates: Until[]): Until {
  return async (snapshot: Snapshot): Promise<Verdict> => {
    const verdicts: Verdict[] = [];
    for (const pred of predicates) {
      const verdict = await pred(snapshot);
      if (!verdict.stop) {
        return verdict;
      }
      verdicts.push(verdict);
    }
    const merged = merge(true, verdicts);
    return {
      ...merged,
      reason: merged.reason ?? 'All predicates satisfied',
    };
  };
}

/** Folds the verdicts that decided a combinator into one, leaving out empty fields. */
function merge(stop: boolean, verdicts: Verdict[]): Verdict {
  const verdict: Verdict = {
    stop,
  };
  const reason = join(
    verdicts.map((v) => v.reason),
    '; ',
  );
  if (reason !== undefined) {
    verdict.reason = reason;
  }
  const feedback = join(
    verdicts.map((v) => v.feedback),
    '\n',
  );
  if (feedback !== undefined) {
    verdict.feedback = feedback;
  }
  return verdict;
}

function join(parts: Array<string | undefined>, separator: string): string | undefined {
  const present = parts.filter((p): p is string => p !== undefined && p !== '');
  return present.length === 0 ? undefined : present.join(separator);
}
