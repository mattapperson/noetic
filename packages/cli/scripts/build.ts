#!/usr/bin/env bun
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const PackageJsonSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
});

const root = resolve(import.meta.dir, '..');
const pkg = PackageJsonSchema.parse(
  JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')),
);

const workspaceDeps = new Set([
  '@noetic/code-agent',
  '@noetic/core',
]);

const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
  'node:*',
].filter((name) => !workspaceDeps.has(name));

const entrypoints = [
  resolve(root, 'src/index.ts'),
  resolve(root, 'src/cli/cli.ts'),
];

rmSync(resolve(root, 'dist'), {
  recursive: true,
  force: true,
});

const result = await Bun.build({
  entrypoints,
  outdir: resolve(root, 'dist'),
  root: resolve(root, 'src'),
  target: 'bun',
  format: 'esm',
  minify: true,
  splitting: false,
  external,
  naming: '[dir]/[name].js',
  sourcemap: 'none',
});

if (!result.success) {
  console.error('Build failed:');
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

chmodSync(resolve(root, 'dist/cli/cli.js'), 0o755);

console.log(`Built ${result.outputs.length} files to dist/`);
