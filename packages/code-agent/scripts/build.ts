#!/usr/bin/env bun
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const ExportEntrySchema = z.object({
  types: z.string().optional(),
  default: z.string().optional(),
});

const PackageJsonSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  exports: z
    .record(
      z.string(),
      z.union([
        z.string(),
        ExportEntrySchema,
      ]),
    )
    .optional(),
});

const root = resolve(import.meta.dir, '..');
const pkg = PackageJsonSchema.parse(
  JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')),
);

const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
  'node:*',
];

const entrypoints: string[] = [];
for (const value of Object.values(pkg.exports ?? {})) {
  const src = typeof value === 'string' ? value : value.default;
  if (typeof src !== 'string') {
    continue;
  }
  if (!src.endsWith('.ts')) {
    continue;
  }
  entrypoints.push(resolve(root, src));
}

if (entrypoints.length === 0) {
  console.error('No .ts entrypoints found in package.json exports');
  process.exit(1);
}

rmSync(resolve(root, 'dist'), {
  recursive: true,
  force: true,
});

const result = await Bun.build({
  entrypoints,
  outdir: resolve(root, 'dist'),
  root: resolve(root, 'src'),
  target: 'node',
  format: 'esm',
  minify: true,
  splitting: true,
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

console.log(`Built ${result.outputs.length} files to dist/`);
