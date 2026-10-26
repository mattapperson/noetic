import type { ContextData } from '@noetic-tools/context';
import type { Snapshot, StepDecide, Until, UntilRun, Verdict } from '@noetic-tools/types';
import { toUntil } from './decider';

/**
 * Combines predicates with OR semantics; stops the loop when any predicate says stop.
 *
 * Predicates run in order and the first stop verdict short-circuits, so it is
 * returned as is. When none stops, the combined verdict carries every
 * predicate's `reason` (joined with `'; '`) and `feedback` (joined with `'\n'`),
 * so a failing `until.verified()` still hands its feedback to `prepareNext`.
 *
 * A predicate may be a decide step asking one boolean question (see `loop`).
 *
 * @public
 * @param predicates - Until predicates or decide steps to evaluate.
 * @returns A combined `Until` that short-circuits on the first stop verdict.
 * @throws `NoeticConfigError` `INVALID_UNTIL_DECIDER` if a decide step does not ask exactly one boolean question.
 */
export function any<TContext = ContextData>(
  ...predicates: Array<Until | StepDecide<TContext>>
): Until {
  const untils = predicates.map(toUntil);
  return async (snapshot: Snapshot, run?: UntilRun): Promise<Verdict> => {
    const verdicts: Verdict[] = [];
    for (const pred of untils) {
      const verdict = await pred(snapshot, run);
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
 * A predicate may be a decide step asking one boolean question (see `loop`).
 *
 * @public
 * @param predicates - Until predicates or decide steps to evaluate.
 * @returns A combined `Until` that requires all predicates to be satisfied.
 * @throws `NoeticConfigError` `INVALID_UNTIL_DECIDER` if a decide step does not ask exactly one boolean question.
 */
export function all<TContext = ContextData>(
  ...predicates: Array<Until | StepDecide<TContext>>
): Until {
  const untils = predicates.map(toUntil);
  return async (snapshot: Snapshot, run?: UntilRun): Promise<Verdict> => {
    const verdicts: Verdict[] = [];
    for (const pred of untils) {
      const verdict = await pred(snapshot, run);
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
