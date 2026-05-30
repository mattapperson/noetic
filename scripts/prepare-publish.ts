#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// npm (>=10) no longer applies `publishConfig` field-overrides on pack/publish,
// and it keeps `devDependencies` — which carry the bun `workspace:` protocol — in
// the tarball. This rewrites a package manifest in place so the published package
// targets `dist/` and ships no workspace deps. The workspace `@noetic/*` packages
// are bundled into `dist` at build time, so they are not needed as runtime deps.
//
// Runs against the ephemeral CI checkout right before `npm publish`; never committed.
// Kept dependency-free (no zod) so it runs from the workspace root.

const NpmConfigKeys = new Set([
  'access',
  'registry',
  'tag',
  'provenance',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

const dir = process.argv[2];
if (!dir) {
  console.error('usage: prepare-publish <packageDir>');
  process.exit(1);
}

const file = resolve(dir, 'package.json');
const parsed = parseJson(readFileSync(file, 'utf8'));
if (!isRecord(parsed)) {
  console.error(`${file} is not a JSON object`);
  process.exit(1);
}
const pkg = parsed;

// Merge publishConfig entry-point overrides (main/types/bin/exports/…) into the
// top-level manifest; skip the npm-only config keys.
const { publishConfig } = pkg;
if (isRecord(publishConfig)) {
  for (const [key, value] of Object.entries(publishConfig)) {
    if (NpmConfigKeys.has(key)) {
      continue;
    }
    pkg[key] = value;
  }
}

delete pkg.publishConfig;
delete pkg.devDependencies;

writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);

const name = typeof pkg.name === 'string' ? pkg.name : dir;
const version = typeof pkg.version === 'string' ? pkg.version : 'unknown';
console.log(`prepared ${name}@${version} for publish`);
