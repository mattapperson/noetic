/**
 * Build `@noetic-tools/core` and `@noetic-tools/code-agent` and pack them into
 * publishable tarballs under `compat/vendor/`.
 *
 * `npm pack` applies each package's `publishConfig` (notably code-agent's
 * `exports` → `dist/*`), so the resulting tarballs resolve exactly like the
 * artifacts published to npm. The compat project installs these tarballs, which
 * is the most faithful way to prove the *built, deployable* packages work on a
 * given runtime — rather than the TypeScript workspace source.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { $ } from 'bun';

const COMPAT_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VENDOR_DIR = join(COMPAT_DIR, 'vendor');

interface PackTarget {
  /** Path to the package directory relative to the repo root. */
  dir: string;
  /** Stable tarball filename written into vendor/. */
  out: string;
}

const TARGETS: ReadonlyArray<PackTarget> = [
  {
    dir: 'packages/core',
    out: 'noetic-core.tgz',
  },
  {
    dir: 'packages/code-agent',
    out: 'noetic-code-agent.tgz',
  },
];

async function packTarget(target: PackTarget): Promise<void> {
  const pkgDir = join(REPO_ROOT, target.dir);
  const manifestPath = join(pkgDir, 'package.json');
  const prepareScript = join(REPO_ROOT, 'scripts', 'prepare-publish.ts');

  console.log(`\n• building ${target.dir}`);
  await $`bun run build`.cwd(pkgDir);

  // Apply the same manifest rewrite the release pipeline uses (publishConfig
  // entry points → dist, strip workspace devDeps), then restore afterwards so
  // the working tree stays clean. This makes the tarball resolve like npm's.
  const originalManifest = await readFile(manifestPath, 'utf8');
  try {
    console.log(`• preparing ${target.dir} manifest for publish`);
    await $`bun ${prepareScript} ${pkgDir}`.cwd(REPO_ROOT);

    console.log(`• packing ${target.dir} → vendor/${target.out}`);
    await $`npm pack --pack-destination ${VENDOR_DIR} --silent`.cwd(pkgDir);
  } finally {
    await writeFile(manifestPath, originalManifest);
  }

  // npm pack writes `<name>-<version>.tgz`; normalize to the stable name.
  const produced = (await readdir(VENDOR_DIR)).filter(
    (name) => name.endsWith('.tgz') && name !== target.out,
  );
  if (produced.length === 0) {
    throw new Error(`npm pack produced no tarball for ${target.dir}`);
  }
  // The only non-stable tarball present is the one we just produced.
  await rename(join(VENDOR_DIR, produced[0]), join(VENDOR_DIR, target.out));
}

async function main(): Promise<void> {
  await rm(VENDOR_DIR, {
    recursive: true,
    force: true,
  });
  await mkdir(VENDOR_DIR, {
    recursive: true,
  });

  for (const target of TARGETS) {
    await packTarget(target);
  }

  console.log('\n✓ packed tarballs:');
  for (const name of await readdir(VENDOR_DIR)) {
    console.log(`  vendor/${name}`);
  }
}

await main();
