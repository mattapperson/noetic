import type { LspServerContribution } from '../types.js';

export const typescriptContribution: LspServerContribution = {
  id: 'typescript',
  extensions: [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.cjs',
    '.mjs',
    '.cts',
    '.mts',
  ],
  rootMarkers: [
    'tsconfig.json',
    'jsconfig.json',
    'package.json',
  ],
  launch: {
    strategy: 'bunx',
    pkg: 'typescript-language-server',
    bin: 'typescript-language-server',
    args: [
      '--stdio',
    ],
    // typescript-language-server spawns tsserver from `typescript` via Node
    // module resolution. Without listing it here, the server installs solo in
    // bunx's cache and initialize fails with "Could not find a valid TypeScript
    // installation."
    peers: [
      'typescript',
    ],
  },
};
