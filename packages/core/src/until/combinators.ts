import type { Snapshot, Until, Verdict } from '@noetic-tools/types';

/**
 * Combines predicates with OR semantics; stops the loop when any predicate says stop.
 *
 * @public
 * @param predicates - Until predicates to evaluate.
 * @returns A combined `Until` that short-circuits on the first stop verdict.
 */
export function any(...predicates: Until[]): Until {
  return async (snapshot: Snapshot): Promise<Verdict> => {
    for (const pred of predicates) {
      const verdict = await pred(snapshot);
      if (verdict.stop) {
        return verdict;
      }
    }
    return {
      stop: false,
    };
  };
}

/**
 * Combines predicates with AND semantics; stops the loop only when all predicates say stop.
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
      verdicts.push(verdict);
      if (!verdict.stop) {
        return {
          stop: false,
        };
      }
    }
    const reasons = verdicts
      .map((v) => v.reason)
      .filter(Boolean)
      .join('; ');
    return {
      stop: true,
      reason: reasons || 'All predicates satisfied',
    };
  };
}
