#!/usr/bin/env bun
/**
 * Decodes the inline base64 sourceMappingURL on a reference .tsx file and
 * writes the pre-compiler original out to a staging directory.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';

//#region Schemas

const SourceMapSchema = z.object({
  version: z.number(),
  sources: z.array(z.string()),
  sourcesContent: z.array(z.string().nullable()).optional(),
});

//#endregion

//#region Types

type SourceMap = z.infer<typeof SourceMapSchema>;

//#endregion

//#region Helpers

const INLINE_MAP_RE =
  /\/\/# sourceMappingURL=data:application\/json;(?:charset=[^,;]+;)?base64,([A-Za-z0-9+/=]+)\s*$/m;

function decodeInlineSourceMap(source: string): SourceMap | null {
  const match = INLINE_MAP_RE.exec(source);
  if (!match || !match[1]) {
    return null;
  }
  const json = Buffer.from(match[1], 'base64').toString('utf-8');
  const parsed = SourceMapSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

function firstSourceContent(map: SourceMap): string | null {
  if (!map.sourcesContent) {
    return null;
  }
  const entry = map.sourcesContent.find((s): s is string => typeof s === 'string');
  return entry ?? null;
}

//#endregion

//#region Main

const GENERIC_PARENT_DIRS = new Set([
  'components',
  'messages',
]);

function stagingName(relPath: string): string {
  // Prefix the parent dir onto leaves under non-generic parents so siblings
  // with the same leaf name (e.g. UI.tsx) don't collide in the flat staging dir.
  const parent = basename(dirname(relPath));
  const leaf = basename(relPath).replace(/\.tsx?$/, '');
  const name = GENERIC_PARENT_DIRS.has(parent) ? leaf : `${parent}.${leaf}`;
  return `${name}.original.tsx`;
}

function extractOne(relPath: string, referenceRoot: string, stagingDir: string): void {
  const inputPath = resolve(referenceRoot, relPath);
  const source = readFileSync(inputPath, 'utf-8');
  const map = decodeInlineSourceMap(source);
  if (!map) {
    console.log(`[skip] no inline sourcemap: ${inputPath}`);
    return;
  }
  const original = firstSourceContent(map);
  if (!original) {
    console.log(`[skip] no sourcesContent: ${inputPath}`);
    return;
  }
  const outPath = resolve(stagingDir, stagingName(relPath));
  mkdirSync(dirname(outPath), {
    recursive: true,
  });
  writeFileSync(outPath, original, 'utf-8');
  console.log(`[ok]   ${relPath}\n       -> ${outPath}`);
}

const HOME = process.env.HOME;
if (!HOME) {
  console.error('extract-source-maps: $HOME is unset; aborting.');
  process.exit(1);
}
const REFERENCE_ROOT = resolve(HOME, 'Desktop/claude-code-main/src');
const STAGING_DIR = resolve(import.meta.dir, '..', 'src/tui/_ref-staging');

const TARGETS = [
  'components/CtrlOToExpand.tsx',
  'components/messages/CollapsedReadSearchContent.tsx',
  'components/StructuredDiff.tsx',
  'tools/FileEditTool/UI.tsx',
  'tools/FileWriteTool/UI.tsx',
] as const;

for (const target of TARGETS) {
  extractOne(target, REFERENCE_ROOT, STAGING_DIR);
}

//#endregion
