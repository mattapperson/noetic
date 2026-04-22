/**
 * Thin wrapper around the `diff` package's `parsePatch` that yields an easier
 * structure for rendering: each line tagged with its kind (add/del/ctx) and
 * paired with its old/new line numbers.
 */

import type { StructuredPatch } from 'diff';
import { parsePatch } from 'diff';

//#region Types

export const DiffLineKind = {
  Add: 'add',
  Del: 'del',
  Ctx: 'ctx',
} as const;

export type DiffLineKind = (typeof DiffLineKind)[keyof typeof DiffLineKind];

export interface DiffLine {
  kind: DiffLineKind;
  /** Line text with the leading `+`/`-`/` ` marker stripped. */
  text: string;
  /** 1-indexed old-file line number; undefined for added lines. */
  oldLine?: number;
  /** 1-indexed new-file line number; undefined for deleted lines. */
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffTotals {
  added: number;
  removed: number;
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  totals: DiffTotals;
}

//#endregion

//#region Helpers

function classify(marker: string): DiffLineKind {
  if (marker === '+') {
    return DiffLineKind.Add;
  }
  if (marker === '-') {
    return DiffLineKind.Del;
  }
  return DiffLineKind.Ctx;
}

function stripMarker(line: string): string {
  return line.length > 0 ? line.slice(1) : line;
}

function tryParsePatch(uniDiff: string): StructuredPatch[] | null {
  try {
    return parsePatch(uniDiff);
  } catch {
    return null;
  }
}

//#endregion

//#region Public API

/**
 * Parse a unified-diff string and emit hunks with per-line kind + numbering.
 * Only the first patch is rendered (single-file diffs from our `edit` tool).
 * Returns null if the diff can't be parsed.
 */
export function parseUnifiedDiff(uniDiff: string): ParsedDiff | null {
  if (!uniDiff.trim()) {
    return null;
  }
  const patches = tryParsePatch(uniDiff);
  if (!patches) {
    return null;
  }
  const patch = patches[0];
  if (!patch || patch.hunks.length === 0) {
    return null;
  }
  const hunks: DiffHunk[] = [];
  const totals: DiffTotals = {
    added: 0,
    removed: 0,
  };
  for (const rawHunk of patch.hunks) {
    let oldLine = rawHunk.oldStart;
    let newLine = rawHunk.newStart;
    const lines: DiffLine[] = [];
    for (const raw of rawHunk.lines) {
      if (raw.startsWith('\\')) {
        continue;
      }
      const kind = classify(raw.charAt(0));
      const text = stripMarker(raw);
      if (kind === DiffLineKind.Add) {
        lines.push({
          kind,
          text,
          newLine,
        });
        newLine += 1;
        totals.added += 1;
        continue;
      }
      if (kind === DiffLineKind.Del) {
        lines.push({
          kind,
          text,
          oldLine,
        });
        oldLine += 1;
        totals.removed += 1;
        continue;
      }
      lines.push({
        kind,
        text,
        oldLine,
        newLine,
      });
      oldLine += 1;
      newLine += 1;
    }
    hunks.push({
      oldStart: rawHunk.oldStart,
      newStart: rawHunk.newStart,
      lines,
    });
  }
  return {
    hunks,
    totals,
  };
}

//#endregion
