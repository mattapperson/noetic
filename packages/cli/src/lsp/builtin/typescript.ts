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
  },
};
