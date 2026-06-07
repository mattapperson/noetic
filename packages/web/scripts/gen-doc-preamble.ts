/**
 * Generates `scripts/doc-preamble.ts` — the ambient preamble that
 * `scripts/check-docs.ts` injects into bare documentation code fences. The
 * preamble imports the full public surface of `@noetic-tools/core` (parsed from
 * its `index.ts` export blocks) plus a few stand-in symbols the docs reference
 * narratively, so snippets that omit imports still type-check.
 *
 * Run after the core public surface changes:
 *   bun scripts/gen-doc-preamble.ts   (or: bun run gen:doc-preamble)
 *
 * Output is formatted with Biome so regeneration is idempotent.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const CORE_INDEX = path.join(WEB_DIR, '../core/src/index.ts');
const OUTPUT = path.join(WEB_DIR, 'scripts/doc-preamble.ts');

const STANDINS = `
declare const searchTool: Tool;
declare const calcTool: Tool;
declare const agent: Step<ContextMemory, string, string>;
declare const observer: (buffer: ReadonlyArray<unknown>) => Promise<string[]>;
declare const semanticRecall: MemoryLayer;
`;

/** Parse `export { ... }` / `export type { ... }` blocks into value and type name sets. */
function collectExports(src: string): {
  values: string[];
  types: string[];
} {
  const values = new Set<string>();
  const types = new Set<string>();
  const blockRe = /export\s+(type\s+)?\{([^}]*)\}/g;
  let match = blockRe.exec(src);
  while (match !== null) {
    const isTypeBlock = Boolean(match[1]);
    for (const entry of (match[2] ?? '').split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) {
        continue;
      }
      const inlineType = trimmed.startsWith('type ');
      const body = inlineType ? trimmed.slice(5).trim() : trimmed;
      const name = (body.split(/\s+as\s+/).pop() ?? '').trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
        continue;
      }
      (isTypeBlock || inlineType ? types : values).add(name);
    }
    match = blockRe.exec(src);
  }
  // A name exported as both a value and a type is imported as a value (which
  // also carries the type), so drop it from the type-only list.
  for (const name of values) {
    types.delete(name);
  }
  return {
    values: [
      ...values,
    ].sort(),
    types: [
      ...types,
    ].sort(),
  };
}

/** Wrap a sorted name list into indented import lines, six per line. */
function wrap(names: string[]): string {
  const lines: string[] = [];
  for (let i = 0; i < names.length; i += 6) {
    lines.push(`  ${names.slice(i, i + 6).join(', ')},`);
  }
  return lines.join('\n');
}

const src = await Bun.file(CORE_INDEX).text();
const { values, types } = collectExports(src);

const preamble = `// Injected by check-docs.ts for bare snippets. Not part of the doc source.
import type {
${wrap(types)}
} from '@noetic-tools/core';
import {
${wrap(values)}
} from '@noetic-tools/core';
${STANDINS}`;

const fileContent = `/**
 * Ambient preamble injected into bare documentation code fences by
 * \`scripts/check-docs.ts\`. It imports the full public surface of
 * \`@noetic-tools/core\` plus a handful of stand-in symbols the docs reference
 * narratively, so that snippets which omit imports still type-check.
 *
 * GENERATED from \`packages/core/src/index.ts\`. Regenerate with:
 *   bun scripts/gen-doc-preamble.ts
 * Do not edit the import lists by hand.
 */

export const DOC_PREAMBLE = ${JSON.stringify(preamble)};
`;

await Bun.write(OUTPUT, fileContent);
const fmt = spawnSync(
  'bunx',
  [
    'biome',
    'format',
    '--write',
    OUTPUT,
  ],
  {
    cwd: WEB_DIR,
    stdio: 'inherit',
  },
);
if (fmt.status !== 0) {
  console.error('biome format failed with status', fmt.status);
  process.exitCode = 1;
} else {
  console.log(`wrote scripts/doc-preamble.ts  values=${values.length} types=${types.length}`);
}
