#!/usr/bin/env bun
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BunPlugin } from 'bun';

const TARGETS = [
  {
    name: 'noetic-linux-x64',
    target: 'bun-linux-x64',
  },
  {
    name: 'noetic-linux-arm64',
    target: 'bun-linux-arm64',
  },
  {
    name: 'noetic-darwin-x64',
    target: 'bun-darwin-x64',
  },
  {
    name: 'noetic-darwin-arm64',
    target: 'bun-darwin-arm64',
  },
  {
    name: 'noetic-windows-x64.exe',
    target: 'bun-windows-x64',
  },
] as const;

type Target = (typeof TARGETS)[number]['target'];

function isTarget(value: string): value is Target {
  return TARGETS.some((t) => t.target === value);
}

const stubDevtools: BunPlugin = {
  name: 'stub-react-devtools-core',
  setup(build) {
    build.onResolve(
      {
        filter: /^react-devtools-core$/,
      },
      () => ({
        path: 'react-devtools-core-stub',
        namespace: 'stub',
      }),
    );
    build.onLoad(
      {
        filter: /.*/,
        namespace: 'stub',
      },
      () => ({
        loader: 'js',
        contents: 'export default {};',
      }),
    );
  },
};

const root = resolve(import.meta.dir, '..');
const binDir = resolve(root, 'dist-bin');
const entry = resolve(root, 'src/cli/cli.ts');

rmSync(binDir, {
  recursive: true,
  force: true,
});

const onlyArg = process.argv[2];
const onlyTarget = onlyArg && isTarget(onlyArg) ? onlyArg : undefined;
if (onlyArg && !onlyTarget) {
  console.error(`Unknown target: ${onlyArg}`);
  process.exit(1);
}

for (const { name, target } of TARGETS) {
  if (onlyTarget && target !== onlyTarget) {
    continue;
  }
  const outfile = resolve(binDir, name);
  console.log(`Compiling ${target} → ${outfile}`);
  const result = await Bun.build({
    entrypoints: [
      entry,
    ],
    minify: true,
    plugins: [
      stubDevtools,
    ],
    compile: {
      target,
      outfile,
    },
  });
  if (!result.success) {
    console.error(`Build failed for ${target}:`);
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}

console.log('Done.');
