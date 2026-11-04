#!/usr/bin/env bun
/**
 * Build smoke test: the published-shape `dist/` must import under plain Node.js
 * ESM, not just Bun. Spawns the real `node` binary to import `dist/index.js`;
 * fails the build if Node cannot resolve the module graph (e.g. extensionless
 * imports that `add-js-extensions.ts` was supposed to fix). Also starts and
 * stops the tool server from `dist/mcp/node.js`, which the main entry only
 * loads on first use and so never reaches through its own graph.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const distIndex = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const distToolServer = fileURLToPath(new URL('../dist/mcp/node.js', import.meta.url));
const distRemote = fileURLToPath(new URL('../dist/remote.js', import.meta.url));

const program = [
  `import(${JSON.stringify(distIndex)})`,
  '.then((m) => {',
  '  const count = Object.keys(m).length;',
  "  if (count < 1) { throw new Error('dist/index.js exported nothing'); }",
  "  console.log('verify-node-esm: imported dist/index.js under Node with ' + count + ' exports');",
  `  return import(${JSON.stringify(distToolServer)});`,
  '})',
  '.then(async (m) => {',
  '  const server = await m.serveToolsOverHttp(() => undefined);',
  '  await server.close();',
  "  console.log('verify-node-esm: started and stopped the tool server under Node');",
  `  return import(${JSON.stringify(distRemote)});`,
  '})',
  '.then(async (m) => {',
  "  const runner = await m.listenAcpRunner({ token: 'verify-node-esm-token' });",
  '  await runner.close();',
  "  console.log('verify-node-esm: started and stopped the remote runner under Node');",
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
