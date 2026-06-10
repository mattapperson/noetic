#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// npm (>=10) no longer applies `publishConfig` field-overrides on pack/publish,
// and it keeps `devDependencies` — which carry the bun `workspace:` protocol — in
// the tarball. This rewrites a package manifest in place so the published package
// targets `dist/` and ships no workspace deps. The workspace `@noetic/*` packages
// are bundled into `dist` at build time, so they are not needed as runtime deps.
//
// It also strips the `bun` export conditions (which resolve to `src/*.ts` in
// development — see CLAUDE.md). The packed tarball ships only `dist/`, so a
// surviving `bun` condition would dangle and break bun consumers of the
// artifact. `npm publish` strips them via each package's `prepublishOnly`
// (scripts/strip-dev-conditions.ts), but `npm pack` — used by compat's
// pack:packages — never runs `prepublishOnly`, so the strip must happen here.
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

// Strip the dev-only `bun` export conditions (recursively — conditions can
// nest) so the manifest resolves only against the `dist/` shipped in the
// tarball, exactly like the npm-published artifact.
function stripBunConditions(node: unknown): void {
  if (!isRecord(node)) {
    return;
  }
  delete node.bun;
  for (const value of Object.values(node)) {
    stripBunConditions(value);
  }
}
stripBunConditions(pkg.exports);
if (JSON.stringify(pkg.exports ?? {}).includes('"bun":')) {
  console.error('prepare-publish: a "bun" export condition survived stripping');
  process.exit(1);
}

// Pin any remaining `workspace:` runtime dependency to a concrete `^<version>`
// range read from the sibling package, so the packed/published tarball is
// installable by an external consumer (npm rejects the `workspace:` protocol).
// `@noetic-tools/<name>` resolves to the sibling package dir at `../<name>`.
const deps = pkg.dependencies;
if (isRecord(deps)) {
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string' || !spec.startsWith('workspace:')) {
      continue;
    }
    const shortName = name.split('/')[1];
    const siblingFile = resolve(dir, '..', shortName, 'package.json');
    const sibling = parseJson(readFileSync(siblingFile, 'utf8'));
    if (isRecord(sibling) && typeof sibling.version === 'string') {
      deps[name] = `^${sibling.version}`;
    }
  }
}

writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);

const name = typeof pkg.name === 'string' ? pkg.name : dir;
const version = typeof pkg.version === 'string' ? pkg.version : 'unknown';
console.log(`prepared ${name}@${version} for publish`);
