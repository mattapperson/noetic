/**
 * Build `@noetic-tools/core` (with its `@noetic-tools/types` and
 * `@noetic-tools/memory` dependencies) and pack them into publishable tarballs
 * under `compat/vendor/`.
 *
 * `npm pack` applies each package's `publishConfig` (notably the `exports` →
 * `dist/*` mapping), so the resulting tarballs resolve exactly like the
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

// Order matters: @noetic-tools/core is built with tsc (its workspace deps are
// NOT bundled), so it imports @noetic-tools/types and @noetic-tools/memory at
// runtime. Build/pack those first so core's build resolves them and the
// external consumer can install them as real tarballs.
const TARGETS: ReadonlyArray<PackTarget> = [
  {
    dir: 'packages/types',
    out: 'noetic-types.tgz',
  },
  {
    dir: 'packages/memory',
    out: 'noetic-memory.tgz',
  },
  {
    dir: 'packages/core',
    out: 'noetic-core.tgz',
  },
];

async function packTarget(target: PackTarget): Promise<void> {
  const pkgDir = join(REPO_ROOT, target.dir);
  const manifestPath = join(pkgDir, 'package.json');
  const prepareScript = join(REPO_ROOT, 'scripts', 'prepare-publish.ts');

  console.log(`\n• building ${target.dir}`);
  await $`bun run build`.cwd(pkgDir);

  // Apply the same manifest rewrite the release pipeline uses (publishConfig
  // entry points → dist, strip workspace devDeps, pin workspace runtime deps),
  // then restore afterwards so the working tree stays clean. This makes the
  // tarball resolve like npm's.
  const originalManifest = await readFile(manifestPath, 'utf8');
  // Snapshot existing tarballs so we can identify exactly the one npm pack
  // creates for THIS target — multiple targets share VENDOR_DIR, so filtering
  // by "non-stable name" is ambiguous once earlier tarballs are renamed.
  const before = new Set((await readdir(VENDOR_DIR)).filter((name) => name.endsWith('.tgz')));
  try {
    console.log(`• preparing ${target.dir} manifest for publish`);
    await $`bun ${prepareScript} ${pkgDir}`.cwd(REPO_ROOT);

    console.log(`• packing ${target.dir} → vendor/${target.out}`);
    await $`npm pack --pack-destination ${VENDOR_DIR} --silent`.cwd(pkgDir);
  } finally {
    await writeFile(manifestPath, originalManifest);
  }

  // npm pack writes `<name>-<version>.tgz`; the new entry is the one absent
  // from the pre-pack snapshot. Normalize it to the stable name.
  const produced = (await readdir(VENDOR_DIR)).filter(
    (name) => name.endsWith('.tgz') && !before.has(name),
  );
  if (produced.length !== 1) {
    throw new Error(
      `expected exactly one new tarball for ${target.dir}, got ${JSON.stringify(produced)}`,
    );
  }
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
