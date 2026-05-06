/**
 * Diff helpers shared by the unified and side-by-side renderers.
 *
 * `Diff.createTwoFilesPatch` from the `diff` package (already a CLI dependency)
 * turns two strings into a unified-diff string; `parseUnifiedDiff` from the
 * existing TUI module turns that into per-line records with old/new line
 * numbers, which is what we need to render a numbered, kind-tagged view.
 */

import { createTwoFilesPatch } from 'diff';
import type { DiffLine, ParsedDiff } from '../../diff/parse-unified-diff.js';
import {
  DiffLineKind,
  flattenHunks,
  gutterWidth,
  markerFor,
  parseUnifiedDiff,
} from '../../diff/parse-unified-diff.js';

//#region Public API

export interface BuildDiffArgs {
  originalContent: string;
  modifiedContent: string;
  originalPath: string;
  modifiedPath: string;
}

/**
 * Build a parsed diff from raw original/modified contents. Returns null when
 * the two sides are identical (no patch produced) or unparseable.
 */
export function buildDiff(args: BuildDiffArgs): ParsedDiff | null {
  if (args.originalContent === args.modifiedContent) {
    return null;
  }
  const patch = createTwoFilesPatch(
    args.originalPath,
    args.modifiedPath,
    args.originalContent,
    args.modifiedContent,
    undefined,
    undefined,
    {
      context: 3,
    },
  );
  return parseUnifiedDiff(patch);
}

export type { DiffLine, ParsedDiff };
export { DiffLineKind, flattenHunks, gutterWidth, markerFor };

//#endregion
