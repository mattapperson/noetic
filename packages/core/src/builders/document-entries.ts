/**
 * The connections a JSON document declares as `{ "mcp": … }` entries in its
 * `connections`. The hydrator records them on the step it builds for the
 * document, and the turn attaches them, as it does a step's `tools` entries,
 * before the tool set is built: every node of the document reaches them by
 * name, and they are released with the turn.
 */

import type { Step } from '@noetic-tools/types';
import type { AttachedEntry } from '../types/connection-entry';

const ENTRIES = new WeakMap<Step, ReadonlyArray<AttachedEntry>>();

/** Records the entries a document declares on the step built for it. */
export function setDocumentEntries(step: Step, entries: ReadonlyArray<AttachedEntry>): void {
  if (entries.length > 0) {
    ENTRIES.set(step, entries);
  }
}

/** The entries a document declares, when `step` is the one built for it. */
export function documentEntriesOf(step: Step): ReadonlyArray<AttachedEntry> {
  return ENTRIES.get(step) ?? [];
}
