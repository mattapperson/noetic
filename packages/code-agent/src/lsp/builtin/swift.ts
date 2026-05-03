import type { LspServerContribution } from '../types.js';

export const swiftContribution: LspServerContribution = {
  id: 'swift',
  extensions: [
    '.swift',
  ],
  rootMarkers: [
    'Package.swift',
    '.swiftpm',
  ],
  launch: {
    strategy: 'path',
    bin: 'sourcekit-lsp',
    args: [],
    installHint: 'Install Xcode (macOS) or the Swift toolchain (https://swift.org/install/).',
  },
};
