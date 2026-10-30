#!/usr/bin/env bun
/**
 * Build smoke test: the published-shape `dist/` must import under plain Node.js
 * ESM, not just Bun. Spawns the real `node` binary to import `dist/index.js`;
 * fails the build if Node cannot resolve the module graph (e.g. extensionless
 * imports that `add-js-extensions.ts` was supposed to fix).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const distIndex = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const program = [
  `import(${JSON.stringify(distIndex)})`,
  '.then((m) => {',
  '  const count = Object.keys(m).length;',
  "  if (count < 1) { throw new Error('dist/index.js exported nothing'); }",
  "  console.log('verify-node-esm: imported dist/index.js under Node with ' + count + ' exports');",
  '})',
  '.catch((error) => {',
  "  console.error('verify-node-esm FAILED: ' + (error && error.message ? error.message : error));",
  '  process.exit(1);',
  '});',
].join('\n');

execFileSync(
  'node',
  [
    '--input-type=module',
    '-e',
    program,
  ],
  {
    stdio: 'inherit',
  },
);
