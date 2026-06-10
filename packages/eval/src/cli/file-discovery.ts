import * as fs from 'node:fs';
import * as path from 'node:path';

//#region Types

export interface EvalFileDiscovery {
  /** Resolved absolute eval file paths. */
  files: string[];
  /** Explicit patterns that resolved to no file (an eval failure: exit 1). */
  unresolved: string[];
}

//#endregion

//#region Helper Functions

function resolveEvalFile(pattern: string): string | null {
  if (fs.existsSync(pattern)) {
    return path.resolve(pattern);
  }
  const withExt = `${pattern}.eval.ts`;
  if (fs.existsSync(withExt)) {
    return path.resolve(withExt);
  }
  return null;
}

function walkDirectory(dir: string, suffix: string, results: string[] = []): string[] {
  const entries = fs.readdirSync(dir, {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
      walkDirectory(fullPath, suffix, results);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(suffix)) {
      results.push(fullPath);
    }
  }
  return results;
}

//#endregion

//#region Public API

/**
 * Resolve eval files. Explicit patterns that match nothing are surfaced in
 * `unresolved` (never silently dropped); with no patterns, the cwd is walked
 * for `.eval.ts` files and an empty result is not an error.
 */
export function discoverEvalFiles(patterns: string[]): EvalFileDiscovery {
  if (patterns.length > 0) {
    const files: string[] = [];
    const unresolved: string[] = [];
    for (const pattern of patterns) {
      const resolved = resolveEvalFile(pattern);
      if (resolved === null) {
        unresolved.push(pattern);
        continue;
      }
      files.push(resolved);
    }
    return {
      files,
      unresolved,
    };
  }
  return {
    files: walkDirectory(process.cwd(), '.eval.ts'),
    unresolved: [],
  };
}

//#endregion
