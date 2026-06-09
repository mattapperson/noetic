/**
 * Force every TS/JS file under a foreign monorepo checkout to be re-exported
 * from the CLI's *local* workspace, so React, Ink, and `@noetic-tools/cli` resolve
 * to a single instance regardless of where the importer lives on disk.
 *
 * Why: a user's config (`~/.config/noetic/config.ts`) typically imports
 * plugins by absolute path into a development checkout, e.g.
 *
 *     import powerline from '/Users/me/dev/noetic/packages/plugin-powerline';
 *
 * When the CLI runs from a git worktree of the *same* monorepo, those plugins
 * resolve `react`/`ink`/`@noetic-tools/cli` relative to the checkout in the import
 * path — not the worktree the CLI is running from. Two React instances in one
 * process break hooks: `useContext` returns null and the TUI crashes during
 * the first render.
 *
 * Bun's runtime `onResolve` plugin hook does not intercept bare specifiers,
 * so we cannot redirect `react` directly. We *can* intercept `onLoad` for
 * absolute file paths, and we use that to swap each foreign-workspace file
 * for a thin proxy that re-exports its local-workspace twin. Subsequent
 * imports inside the local file (relative paths and bare specifiers like
 * `react`) then resolve from the local `node_modules/`, so every part of the
 * process shares one React, one Ink, and one Context.
 *
 * Must run before any user-config or plugin import.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plugin } from 'bun';
import { z } from 'zod';

const PackageJsonSchema = z.object({
  name: z.string().optional(),
  workspaces: z.unknown().optional(),
});

type Loader = 'ts' | 'tsx' | 'js' | 'jsx';

const LOADERS: Record<string, Loader> = {
  '.tsx': 'tsx',
  '.jsx': 'jsx',
  '.js': 'js',
  '.ts': 'ts',
};

function pickLoader(path: string): Loader {
  return LOADERS[extname(path)] ?? 'ts';
}

function readPackageJson(dir: string): {
  name?: string;
  workspaces?: unknown;
} | null {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) {
    return null;
  }
  try {
    const parsed = PackageJsonSchema.safeParse(JSON.parse(readFileSync(pkgPath, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function findWorkspaceRoot(start: string): string | null {
  let dir = start;
  while (true) {
    const pkg = readPackageJson(dir);
    if (pkg && pkg.workspaces !== undefined) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Resolve the main-repo root from a worktree's `.git` pointer file. Returns
 * null when this checkout is not a worktree.
 */
function findMainRepoRoot(cliWorkspaceRoot: string): string | null {
  const dotGit = join(cliWorkspaceRoot, '.git');
  if (!existsSync(dotGit)) {
    return null;
  }
  let contents: string;
  try {
    contents = readFileSync(dotGit, 'utf8');
  } catch {
    return null;
  }
  const match = contents.match(/^gitdir:\s*(.+)$/m);
  if (!match) {
    return null;
  }
  // gitdir points at <main>/.git/worktrees/<name>; walk up two levels.
  const gitdir = match[1].trim();
  const candidate = dirname(dirname(dirname(gitdir)));
  return candidate && candidate !== cliWorkspaceRoot ? candidate : null;
}

function workspacePackageNames(workspaceRoot: string): Set<string> {
  const names = new Set<string>();
  for (const groupName of [
    'packages',
    'examples',
  ]) {
    const group = join(workspaceRoot, groupName);
    if (!existsSync(group)) {
      continue;
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(group);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = readPackageJson(join(group, entry))?.name;
      if (name) {
        names.add(name);
      }
    }
  }
  return names;
}

function escapeRegex(s: string): string {
  return s.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

export function installWorkspaceProxy(): void {
  const cliWorkspaceRoot = findWorkspaceRoot(fileURLToPath(new URL('.', import.meta.url)));
  if (!cliWorkspaceRoot) {
    return;
  }
  const mainRepoRoot = findMainRepoRoot(cliWorkspaceRoot);
  if (!mainRepoRoot) {
    return;
  }
  const cliPackages = workspacePackageNames(cliWorkspaceRoot);
  if (cliPackages.size === 0) {
    return;
  }

  const filter = new RegExp(
    `^${escapeRegex(mainRepoRoot)}/(packages|examples)/([^/]+)/(.+\\.(?:tsx?|jsx?))$`,
  );

  // Memoize repeated lookups: every file in `packages/foo/...` would otherwise
  // re-read the same package.json and re-stat the same twin path on each load.
  const groupNameCache = new Map<string, string | null>();
  const twinExistsCache = new Map<string, boolean>();

  function packageNameForGroup(groupRoot: string): string | null {
    const cached = groupNameCache.get(groupRoot);
    if (cached !== undefined) {
      return cached;
    }
    const name = readPackageJson(groupRoot)?.name ?? null;
    groupNameCache.set(groupRoot, name);
    return name;
  }

  function twinExists(localPath: string): boolean {
    const cached = twinExistsCache.get(localPath);
    if (cached !== undefined) {
      return cached;
    }
    const exists = existsSync(localPath);
    twinExistsCache.set(localPath, exists);
    return exists;
  }

  function loadRaw(path: string): {
    contents: string;
    loader: Loader;
  } {
    return {
      contents: readFileSync(path, 'utf8'),
      loader: pickLoader(path),
    };
  }

  plugin({
    name: 'noetic-workspace-proxy',
    setup(build) {
      build.onLoad(
        {
          filter,
        },
        (args) => {
          const match = args.path.match(filter);
          if (!match) {
            return loadRaw(args.path);
          }
          // Capture groups 1–3 are guaranteed by the filter regex above.
          const groupName = match[1] ?? '';
          const packageDirName = match[2] ?? '';
          const relWithinPackage = match[3] ?? '';
          const groupRoot = join(mainRepoRoot, groupName, packageDirName);
          const pkgName = packageNameForGroup(groupRoot);
          if (pkgName === null || !cliPackages.has(pkgName)) {
            return loadRaw(args.path);
          }
          const localPath = join(cliWorkspaceRoot, groupName, packageDirName, relWithinPackage);
          if (!twinExists(localPath)) {
            return loadRaw(args.path);
          }
          const target = JSON.stringify(localPath);
          return {
            contents: `import * as __noeticProxy from ${target};\nexport * from ${target};\nexport default __noeticProxy.default;\n`,
            loader: 'ts',
          };
        },
      );
    },
  });
}
