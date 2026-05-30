/**
 * Produce the runtime bundles the deployment matrix needs:
 *
 *   - Node:    `dist/node/run.mjs` — the CLI entry with all packages left
 *              *external*, so Node resolves the installed tarballs from
 *              `compat/node_modules` at runtime (proves real ESM resolution of
 *              the published artifacts on Node).
 *   - Deno:    `dist/deno/run.mjs` — a self-contained bundle (the noetic
 *              packages inlined from their installed `dist`, only `node:`
 *              builtins left external, which Deno supports via node-compat).
 *              Deno's npm interop refuses `file:` tarball specifiers, so the
 *              self-contained bundle is the portable way to run the built code.
 *   - Browser: `dist/browser/bundle.js` — the browser entry fully bundled for a
 *              DOM context (proves the packages bundle and run in a browser).
 *
 * Bun runs the TypeScript entry directly, so it needs no bundle.
 *
 * The `file:` tarball dependencies make Bun's bundler resolve `@noetic-tools/*`
 * to the `.tgz` archive instead of the extracted package. The resolver plugin
 * below redirects those bare specifiers to the installed `node_modules` `dist`
 * so the self-contained bundles pull in the real built artifacts.
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BunPlugin } from 'bun';
import { $ } from 'bun';

const COMPAT_DIR = fileURLToPath(new URL('..', import.meta.url));

const NOETIC_PACKAGE = /^@noetic-tools\/(core|code-agent)$/;

/** Redirect `@noetic-tools/*` bare imports to their installed dist entry. */
const noeticResolver: BunPlugin = {
  name: 'noetic-node-modules',
  setup(build) {
    build.onResolve(
      {
        filter: NOETIC_PACKAGE,
      },
      (args) => {
        const match = NOETIC_PACKAGE.exec(args.path);
        const subpackage = match?.[1] ?? 'core';
        return {
          path: join(COMPAT_DIR, 'node_modules', '@noetic-tools', subpackage, 'dist', 'index.js'),
        };
      },
    );
  },
};

async function buildNodeBundle(): Promise<void> {
  console.log('• bundling Node entry → dist/node/run.mjs');
  await $`bun build runtimes/cli.ts --target=node --packages=external --outfile=dist/node/run.mjs`.cwd(
    COMPAT_DIR,
  );
}

async function buildDenoBundle(): Promise<void> {
  console.log('• bundling Deno entry → dist/deno/run.mjs');
  const result = await Bun.build({
    entrypoints: [
      join(COMPAT_DIR, 'runtimes', 'cli.ts'),
    ],
    target: 'node',
    plugins: [
      noeticResolver,
    ],
    outdir: join(COMPAT_DIR, 'dist', 'deno'),
    naming: 'run.mjs',
  });
  assertBuilt(result, 'Deno');
}

async function buildBrowserBundle(): Promise<void> {
  console.log('• bundling browser entry → dist/browser/bundle.js');
  const result = await Bun.build({
    entrypoints: [
      join(COMPAT_DIR, 'runtimes', 'browser', 'entry.ts'),
    ],
    target: 'browser',
    plugins: [
      noeticResolver,
    ],
    outdir: join(COMPAT_DIR, 'dist', 'browser'),
    naming: 'bundle.js',
  });
  assertBuilt(result, 'browser');
}

function assertBuilt(
  result: {
    success: boolean;
    logs: ReadonlyArray<unknown>;
  },
  label: string,
): void {
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error(`${label} bundle failed`);
  }
}

async function main(): Promise<void> {
  await buildNodeBundle();
  await buildDenoBundle();
  await buildBrowserBundle();
  console.log('✓ bundles built');
}

await main();
