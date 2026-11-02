#!/usr/bin/env bun
/**
 * Publish-time helper: remove the `bun` export conditions from this
 * package's package.json. In development the `bun` condition resolves
 * imports straight to `src/*.ts` (so a stale `dist/` can never break the
 * workspace), but the published tarball ships only `dist/` — a dangling
 * `bun` condition would break bun consumers of the npm package.
 *
 * Run from `prepublishOnly` (cwd = this package root). Like
 * pin-workspace-deps.ts, this only mutates the ephemeral publish checkout;
 * the git-committed package.json keeps the `bun` conditions.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MANIFEST = fileURLToPath(new URL('../package.json', import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
if (!isRecord(manifest) || !isRecord(manifest.exports)) {
  throw new Error(`strip-dev-conditions: no exports map in ${MANIFEST}`);
}

let stripped = 0;
for (const entry of Object.values(manifest.exports)) {
  if (!isRecord(entry)) {
    continue;
  }
  if ('bun' in entry) {
    delete entry.bun;
    stripped += 1;
  }
}

const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
if (serialized.includes('"bun":')) {
  throw new Error('strip-dev-conditions: a "bun" condition survived stripping');
}
writeFileSync(MANIFEST, serialized);
console.log(`strip-dev-conditions: removed ${stripped} bun condition(s)`);
