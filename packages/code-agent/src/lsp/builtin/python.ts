import type { LspServerContribution } from '../types.js';

export const pythonContribution: LspServerContribution = {
  id: 'python',
  extensions: [
    '.py',
    '.pyi',
  ],
  rootMarkers: [
    'pyproject.toml',
    'setup.py',
    'setup.cfg',
    'requirements.txt',
    'Pipfile',
  ],
  launch: {
    strategy: 'bunx',
    pkg: 'pyright',
    bin: 'pyright-langserver',
    args: [
      '--stdio',
    ],
  },
};
