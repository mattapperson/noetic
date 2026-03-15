import type { Until, Snapshot, Verdict } from '../types/step';

export function any(...predicates: Until[]): Until {
  return async (snapshot: Snapshot): Promise<Verdict> => {
    for (const pred of predicates) {
      const verdict = await pred(snapshot);
      if (verdict.stop) return verdict;
    }
    return { stop: false };
  };
}

export function all(...predicates: Until[]): Until {
  return async (snapshot: Snapshot): Promise<Verdict> => {
    const verdicts: Verdict[] = [];
    for (const pred of predicates) {
      const verdict = await pred(snapshot);
      verdicts.push(verdict);
      if (!verdict.stop) return { stop: false };
    }
    const reasons = verdicts
      .map((v) => v.reason)
      .filter(Boolean)
      .join('; ');
    return { stop: true, reason: reasons || 'All predicates satisfied' };
  };
}
