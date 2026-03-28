/**
 * CI script: validates that every exported symbol has a visibility JSDoc tag.
 *
 * - index.ts exports must have @public
 * - unstable.ts exports must have @unstable
 * - @internal symbols must NOT appear in any entry point
 *
 * Usage: bun scripts/check-export-tags.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

//#region Types

interface Violation {
  file: string;
  symbol: string;
  issue: string;
}

interface EntryPoint {
  filePath: string;
  requiredTag: string;
  forbiddenTag: string;
}

//#endregion

//#region Parsing

/**
 * Extracts export statements and their preceding JSDoc comments from a source file.
 * Uses regex-based parsing — does not require the TypeScript compiler API.
 */
function extractExportsWithJsDoc(source: string): Array<{
  names: string[];
  jsDoc: string;
}> {
  const results: Array<{
    names: string[];
    jsDoc: string;
  }> = [];

  // Match export declarations with optional preceding JSDoc
  const exportRe =
    /(?:\/\*\*[\s\S]*?\*\/\s*)?export\s+(?:type\s+)?{([^}]+)}\s+from\s+['"][^'"]+['"]/g;

  for (const match of source.matchAll(exportRe)) {
    const fullMatch = match[0];

    // Extract JSDoc if present
    const jsDocMatch = fullMatch.match(/\/\*\*([\s\S]*?)\*\//);
    const jsDoc = jsDocMatch ? jsDocMatch[0] : '';

    // Extract symbol names
    const namesStr = match[1];
    const names = namesStr
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0);

    results.push({
      names,
      jsDoc,
    });
  }

  return results;
}

//#endregion

//#region Validation

function validateEntryPoint(entryPoint: EntryPoint): Violation[] {
  const violations: Violation[] = [];
  const absolutePath = path.resolve(entryPoint.filePath);

  if (!fs.existsSync(absolutePath)) {
    return [];
  }

  const source = fs.readFileSync(absolutePath, 'utf-8');
  const exports = extractExportsWithJsDoc(source);

  for (const { names, jsDoc } of exports) {
    for (const name of names) {
      if (jsDoc.includes(`@${entryPoint.forbiddenTag}`)) {
        violations.push({
          file: entryPoint.filePath,
          symbol: name,
          issue: `has @${entryPoint.forbiddenTag} tag but is exported from ${entryPoint.filePath}`,
        });
        continue;
      }

      if (!jsDoc.includes(`@${entryPoint.requiredTag}`)) {
        violations.push({
          file: entryPoint.filePath,
          symbol: name,
          issue: `missing @${entryPoint.requiredTag} tag`,
        });
      }
    }
  }

  return violations;
}

//#endregion

//#region Main

const ENTRY_POINTS: EntryPoint[] = [
  {
    filePath: 'packages/core/src/index.ts',
    requiredTag: 'public',
    forbiddenTag: 'internal',
  },
  {
    filePath: 'packages/core/src/unstable.ts',
    requiredTag: 'unstable',
    forbiddenTag: 'internal',
  },
];

let totalViolations = 0;

for (const entryPoint of ENTRY_POINTS) {
  const violations = validateEntryPoint(entryPoint);
  totalViolations += violations.length;

  if (violations.length > 0) {
    console.error(`\n${entryPoint.filePath}:`);
    console.error('─'.repeat(60));
    for (const v of violations) {
      console.error(`  ✗ ${v.symbol}: ${v.issue}`);
    }
  }
}

if (totalViolations > 0) {
  console.error(`\n${totalViolations} export tag violation(s) found.`);
  process.exit(1);
} else {
  console.log('All export tags valid.');
}

//#endregion
