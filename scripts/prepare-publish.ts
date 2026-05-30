#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

// npm (>=10) no longer applies `publishConfig` field-overrides on pack/publish,
// and it keeps `devDependencies` — which carry the bun `workspace:` protocol — in
// the tarball. This rewrites a package manifest in place so the published package
// targets `dist/` and ships no workspace deps. The workspace `@noetic/*` packages
// are bundled into `dist` at build time, so they are not needed as runtime deps.
//
// Runs against the ephemeral CI checkout right before `npm publish`; never committed.

const NpmConfigKeys = new Set([
  'access',
  'registry',
  'tag',
  'provenance',
]);

const ManifestSchema = z.record(z.string(), z.unknown());

const dir = process.argv[2];
if (!dir) {
  console.error('usage: prepare-publish <packageDir>');
  process.exit(1);
}

const file = resolve(dir, 'package.json');
const pkg = ManifestSchema.parse(JSON.parse(readFileSync(file, 'utf8')));

const publishConfig = pkg.publishConfig;
if (publishConfig && typeof publishConfig === 'object') {
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
