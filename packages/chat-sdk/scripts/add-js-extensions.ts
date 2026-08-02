#!/usr/bin/env bun
/**
 * Post-build: rewrite extensionless relative import/export specifiers in the
 * compiled `dist/` so the published package resolves under plain Node.js ESM
 * (not just Bun and bundlers).
 *
 * `tsc` with `moduleResolution: "bundler"` emits relative specifiers verbatim
 * (e.g. `from './adapters/in-memory-fs-adapter'`). Node's ESM resolver requires
 * a concrete target, so those specifiers fail with `ERR_MODULE_NOT_FOUND`.
 *
 * For each relative specifier (`./` or `../`) without an extension this resolves
 * it against the importing file's directory:
 *   - `<spec>.js` exists on disk        -> append `.js`
 *   - `<spec>/index.js` exists on disk  -> append `/index.js`
 * Already-extensioned and bare package specifiers are left untouched. Both `.js`
 * and `.d.ts` outputs are processed (declaration specifiers also reference `.js`).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

const SPECIFIER = /(from\s+|import\s+|import\()(['"])(\.\.?\/[^'"]+)(['"])/g;
const HAS_EXTENSION = /\.(js|mjs|cjs|json|node)$/;

function resolveSpecifier(fromFile: string, spec: string): string {
  if (HAS_EXTENSION.test(spec)) {
    return spec;
  }
  const base = resolve(dirname(fromFile), spec);
  if (existsSync(`${base}.js`)) {
    return `${spec}.js`;
  }
  if (existsSync(join(base, 'index.js'))) {
    return `${spec}/index.js`;
  }
  return spec;
}

function listOutputFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, {
    withFileTypes: true,
  })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listOutputFiles(full));
      continue;
    }
    if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

let rewritten = 0;
for (const file of listOutputFiles(DIST)) {
  const source = readFileSync(file, 'utf8');
  const next = source.replace(SPECIFIER, (match: string, ...groups: string[]): string => {
    const [keyword, openQuote, spec, closeQuote] = groups;
    const fixed = resolveSpecifier(file, spec);
    if (fixed === spec) {
      return match;
    }
    return `${keyword}${openQuote}${fixed}${closeQuote}`;
  });
  if (next !== source) {
    writeFileSync(file, next);
    rewritten += 1;
  }
}

console.log(`add-js-extensions: rewrote ${rewritten} file(s) in dist/`);
