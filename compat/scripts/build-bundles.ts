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
 *   - Browser: `dist/browser/bundle.js` — the full smoke bundled with esbuild
 *              and `esbuild-plugin-polyfill-node`, the same kind of pipeline a
 *              real Next.js/webpack/esbuild browser app uses. code-agent pulls
 *              in `node:` builtins (path/crypto/os/fs/net/url/module); the
 *              polyfill plugin shims them, plus a tiny custom shim gives
 *              `node:module`/`node:url` working load-time functions.
 *
 * Bun runs the TypeScript entry directly, so it needs no bundle.
 *
 * The Bun-based bundles use a resolver plugin because Bun's bundler resolves the
 * `file:` tarball dependency to the `.tgz` archive; esbuild resolves the
 * extracted `node_modules` package normally, so the browser build needs none.
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BunPlugin } from 'bun';
import { $ } from 'bun';
import * as esbuild from 'esbuild';
import { polyfillNode } from 'esbuild-plugin-polyfill-node';

const COMPAT_DIR = fileURLToPath(new URL('..', import.meta.url));

const NOETIC_PACKAGE = /^@noetic-tools\/(core|code-agent)$/;

/** Redirect `@noetic-tools/*` bare imports to their installed dist entry (Bun). */
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

/**
 * esbuild shim for `node:module`/`node:url`. `esbuild-plugin-polyfill-node`
 * stubs these out, but code-agent calls `createRequire(...)` and
 * `fileURLToPath(...)` at module load, so they must be real functions (the
 * require they return is only invoked on Node-only paths the smoke never hits).
 */
const MODULE_SHIM =
  'export function createRequire(){return (id)=>{throw new Error("require("+id+") is unavailable in the browser");};}\n' +
  'export default {createRequire};';
const URL_SHIM = [
  'export function fileURLToPath(u){const s=String(u);return s.startsWith("file://")?decodeURIComponent(s.slice(7)):s;}',
  'export function pathToFileURL(p){return new URL("file://"+p);}',
  'export const URL=globalThis.URL;export const URLSearchParams=globalThis.URLSearchParams;',
  'export default {fileURLToPath,pathToFileURL,URL,URLSearchParams};',
].join('\n');

const loadShims: esbuild.Plugin = {
  name: 'node-load-shims',
  setup(build) {
    build.onResolve(
      {
        filter: /^(node:)?(module|url)$/,
      },
      (args) => ({
        path: args.path.replace(/^node:/, ''),
        namespace: 'node-load-shim',
      }),
    );
    build.onLoad(
      {
        filter: /.*/,
        namespace: 'node-load-shim',
      },
      (args) => ({
        contents: args.path === 'module' ? MODULE_SHIM : URL_SHIM,
        loader: 'js',
      }),
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
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error('Deno bundle failed');
  }
}

async function buildBrowserBundle(): Promise<void> {
  console.log('• bundling browser entry (esbuild + node polyfills) → dist/browser/bundle.js');
  await esbuild.build({
    entryPoints: [
      join(COMPAT_DIR, 'runtimes', 'browser', 'entry.ts'),
    ],
    outfile: join(COMPAT_DIR, 'dist', 'browser', 'bundle.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    plugins: [
      loadShims,
      polyfillNode({}),
    ],
  });
}

async function main(): Promise<void> {
  await buildNodeBundle();
  await buildDenoBundle();
  await buildBrowserBundle();
  console.log('✓ bundles built');
}

await main();
