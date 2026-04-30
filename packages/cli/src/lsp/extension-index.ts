/**
 * Runtime index mapping file extensions to contributions. Built once per
 * harness from `[...builtins, ...pluginContributions]`. Later contributions
 * override earlier ones by `id` (plugins can replace builtins). For extension
 * collisions across different ids, first-registered wins.
 */

import type { LspServerContribution } from './types.js';

//#region Types

export interface ExtensionIndex {
  /** Lookup the contribution responsible for a given file extension (with leading dot). */
  resolveByExtension(ext: string): LspServerContribution | null;
  /** Lookup a contribution by its id. */
  resolveById(id: string): LspServerContribution | null;
  /** All registered contributions, in resolution order (builtins first, then plugins). */
  list(): ReadonlyArray<LspServerContribution>;
}

//#endregion

//#region Helpers

function mergeById(
  contributions: ReadonlyArray<LspServerContribution>,
): ReadonlyArray<LspServerContribution> {
  const byId = new Map<string, LspServerContribution>();
  for (const contribution of contributions) {
    byId.set(contribution.id, contribution);
  }
  return Array.from(byId.values());
}

function buildExtensionMap(
  contributions: ReadonlyArray<LspServerContribution>,
): Map<string, LspServerContribution> {
  const byExt = new Map<string, LspServerContribution>();
  for (const contribution of contributions) {
    for (const ext of contribution.extensions) {
      const normalized = ext.toLowerCase();
      if (byExt.has(normalized)) {
        continue;
      }
      byExt.set(normalized, contribution);
    }
  }
  return byExt;
}

function extractExtension(filePath: string): string | null {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot < 0) {
    return null;
  }
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  // Reject dotfiles: e.g. for `.bashrc` or `/home/u/.bashrc` the only `.` is
  // the leading filename dot, not an extension separator. An extension must be
  // preceded by at least one character of filename.
  if (lastDot <= lastSep + 1) {
    return null;
  }
  return filePath.slice(lastDot).toLowerCase();
}

//#endregion

//#region Public API

/**
 * Build an ExtensionIndex from the aggregated contribution list. Call once per
 * harness construction — the returned object is immutable.
 */
export function createExtensionIndex(
  contributions: ReadonlyArray<LspServerContribution>,
): ExtensionIndex {
  const merged = mergeById(contributions);
  const byExt = buildExtensionMap(merged);
  const byId = new Map<string, LspServerContribution>(
    merged.map((c) => [
      c.id,
      c,
    ]),
  );

  return {
    resolveByExtension: (ext: string) => byExt.get(ext.toLowerCase()) ?? null,
    resolveById: (id: string) => byId.get(id) ?? null,
    list: () => merged,
  };
}

/**
 * Convenience: extract the extension from a file path and resolve the
 * contribution in one step. Returns null if the extension isn't registered.
 */
export function resolveContributionForFile(
  index: ExtensionIndex,
  filePath: string,
): LspServerContribution | null {
  const ext = extractExtension(filePath);
  if (!ext) {
    return null;
  }
  return index.resolveByExtension(ext);
}

//#endregion
