import type { LspServerContribution } from '../types.js';

export const goContribution: LspServerContribution = {
  id: 'go',
  extensions: [
    '.go',
  ],
  rootMarkers: [
    'go.mod',
    'go.work',
  ],
  launch: {
    strategy: 'path',
    bin: 'gopls',
    args: [],
    installHint: 'go install golang.org/x/tools/gopls@latest',
  },
};
