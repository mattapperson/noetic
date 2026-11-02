#!/usr/bin/env bun
/**
 * Publish-time helper: rewrite `workspace:*` dependency specifiers in this
 * package's package.json to a concrete `^<version>` range, reading the
 * sibling package's currently-released version from disk.
 *
 * Run from `prepublishOnly` (cwd = this package root) so the published
 * tarball carries real npm ranges. The git-committed package.json keeps
 * `workspace:*` — this edit only mutates the ephemeral CI checkout.
 *
 * `@noetic-tools/<name>` resolves to the sibling at `../<name>`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MANIFEST = fileURLToPath(new URL('../package.json', import.meta.url));
const WORKSPACE_RE = /^workspace:/;

function siblingVersion(depName: string): string {
  const shortName = depName.split('/')[1];
  const siblingManifest = fileURLToPath(
    new URL(`../../${shortName}/package.json`, import.meta.url),
  );
  const parsed = JSON.parse(readFileSync(siblingManifest, 'utf8'));
  if (typeof parsed.version !== 'string') {
    throw new Error(`Sibling ${depName} has no version in ${siblingManifest}`);
  }
  return parsed.version;
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const deps: Record<string, string> = manifest.dependencies ?? {};
let rewritten = 0;
for (const [name, spec] of Object.entries(deps)) {
  if (!WORKSPACE_RE.test(spec)) {
    continue;
  }
  deps[name] = `^${siblingVersion(name)}`;
  rewritten += 1;
}

if (rewritten > 0) {
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}
console.log(`pin-workspace-deps: pinned ${rewritten} workspace dependency(ies)`);
