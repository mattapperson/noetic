/**
 * Pure helpers for the prompt's reverse-incremental history search
 * (`Ctrl+R`, readline / bash convention).
 *
 * The `index` semantics mirror `PromptHistoryState`: 0 = newest entry, N-1 =
 * oldest. A `findReverseMatch` walks forward through the array (newest →
 * oldest) starting at `fromIndex`, which is the same direction every Ctrl+R
 * press cycles.
 *
 * Matching is case-insensitive substring on the entire stored entry. Empty
 * query trivially matches every entry; the first hit (newest) is returned.
 */

//#region Types

export interface SearchModeState {
  /** Current query text. Extended by typing, shrunk by Backspace. */
  readonly query: string;
  /** Index of the entry currently shown as the match. -1 when no match. */
  readonly matchIndex: number;
  /** Prompt-buffer contents when search began. Restored on cancel. */
  readonly savedBuffer: string;
}

export interface ReverseMatchResult {
  /** The matched entry text. Empty string if no match. */
  readonly value: string;
  /** The matched entry's index in `entries`, or -1 if no match. */
  readonly index: number;
}

//#endregion

//#region Public API

export function createSearchModeState(savedBuffer: string): SearchModeState {
  return {
    query: '',
    matchIndex: 0,
    savedBuffer,
  };
}

/**
 * Walk `entries[fromIndex..]` from newest to oldest looking for the first
 * substring (case-insensitive) match. Returns `index: -1` and an empty
 * value when nothing matches.
 *
 * An empty `query` is treated as a match for whatever entry sits at
 * `fromIndex` (or `-1` if `fromIndex` is past the end). This mirrors
 * bash's behaviour: Ctrl+R with no query parked at the previous entry
 * shows it as the current match.
 */
export function findReverseMatch(
  entries: ReadonlyArray<string>,
  fromIndex: number,
  query: string,
): ReverseMatchResult {
  if (entries.length === 0 || fromIndex < 0 || fromIndex >= entries.length) {
    return {
      value: '',
      index: -1,
    };
  }
  if (query.length === 0) {
    const value = entries[fromIndex];
    if (value === undefined) {
      return {
        value: '',
        index: -1,
      };
    }
    return {
      value,
      index: fromIndex,
    };
  }
  const needle = query.toLowerCase();
  for (let i = fromIndex; i < entries.length; i++) {
    const entry = entries[i];
    if (entry?.toLowerCase().includes(needle)) {
      return {
        value: entry,
        index: i,
      };
    }
  }
  return {
    value: '',
    index: -1,
  };
}

//#endregion
