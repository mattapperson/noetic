/**
 * Collects the type universe the Monaco editor needs to typecheck the agent
 * file for real: workspace packages as their `src/*.ts` (the same files the
 * `bun` export condition resolves to — no build step, never stale), and the
 * external type deps (`zod`, the OpenRouter SDK/agent) as their published
 * `.d.ts`. The editor registers each entry as a virtual
 * `node_modules/<pkg>/<rel>` file in the TS worker.
 *
 * Workspace packages get a synthetic package.json pointing `types` at
 * `src/index.ts` because the worker resolves with node10 semantics — the
 * real package.json's `exports`/`bun` conditions would not be honored.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const WORKSPACE_PACKAGES = [
  'types',
  'context',
  'core',
  'platform-node',
  'sub-harness',
] as const;

const EXTERNAL_PACKAGES = [
  'zod',
  '@openrouter/sdk',
  '@openrouter/agent',
] as const;

//#region Walk

function walk(root: string, keep: (file: string) => boolean): string[] {
  const found: string[] = [];
  const pending = [
    root,
  ];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) {
      break;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git') {
        continue;
      }
      const full = path.join(dir, entry);
      let isDirectory: boolean;
      try {
        // statSync follows symlinks — bun lays packages out behind them.
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) {
        pending.push(full);
        continue;
      }
      if (keep(full)) {
        found.push(full);
      }
    }
  }
  return found;
}

function isSourceType(file: string): boolean {
  return file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.cts');
}

function isDeclaration(file: string): boolean {
  return (
    file.endsWith('.d.ts') || file.endsWith('.d.cts') || path.basename(file) === 'package.json'
  );
}

//#endregion

//#region Collect

function addWorkspacePackage(files: Record<string, string>, repoRoot: string, pkg: string): void {
  const srcRoot = path.join(repoRoot, 'packages', pkg, 'src');
  for (const file of walk(srcRoot, isSourceType)) {
    const rel = path.relative(srcRoot, file);
    files[`node_modules/@noetic-tools/${pkg}/src/${rel}`] = readFileSync(file, 'utf8');
  }
  files[`node_modules/@noetic-tools/${pkg}/package.json`] = JSON.stringify({
    name: `@noetic-tools/${pkg}`,
    types: './src/index.ts',
  });
}

function addExternalPackage(files: Record<string, string>, repoRoot: string, pkg: string): void {
  const pkgRoot = path.join(repoRoot, 'node_modules', pkg);
  for (const file of walk(pkgRoot, isDeclaration)) {
    const rel = path.relative(pkgRoot, file);
    files[`node_modules/${pkg}/${rel}`] = readFileSync(file, 'utf8');
  }
}

export function collectTypeLibs(repoRoot: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const pkg of WORKSPACE_PACKAGES) {
    addWorkspacePackage(files, repoRoot, pkg);
  }
  for (const pkg of EXTERNAL_PACKAGES) {
    addExternalPackage(files, repoRoot, pkg);
  }
  return files;
}

//#endregion
