import * as fs from 'node:fs';
import * as path from 'node:path';

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

export function discoverEvalFiles(patterns: string[]): string[] {
  if (patterns.length > 0) {
    return patterns.map((p) => resolveEvalFile(p)).filter((f): f is string => f !== null);
  }
  return walkDirectory(process.cwd(), '.eval.ts');
}

//#endregion
