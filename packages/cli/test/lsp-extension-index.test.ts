import { describe, expect, it } from 'bun:test';

import { createBuiltinLspServers } from '../src/lsp/builtin/index.js';
import { createExtensionIndex, resolveContributionForFile } from '../src/lsp/extension-index.js';
import type { LspServerContribution } from '../src/lsp/types.js';

function makeContribution(id: string, extensions: ReadonlyArray<string>): LspServerContribution {
  return {
    id,
    extensions,
    rootMarkers: [
      'package.json',
    ],
    launch: {
      strategy: 'path',
      bin: id,
      args: [],
    },
  };
}

describe('createExtensionIndex', () => {
  const builtins = createBuiltinLspServers();
  const index = createExtensionIndex(builtins);

  it('resolves all v1 builtin extensions to the expected contribution id', () => {
    const cases: Array<
      [
        string,
        string,
      ]
    > = [
      [
        '.ts',
        'typescript',
      ],
      [
        '.tsx',
        'typescript',
      ],
      [
        '.js',
        'typescript',
      ],
      [
        '.mjs',
        'typescript',
      ],
      [
        '.cjs',
        'typescript',
      ],
      [
        '.py',
        'python',
      ],
      [
        '.pyi',
        'python',
      ],
      [
        '.go',
        'go',
      ],
      [
        '.swift',
        'swift',
      ],
    ];
    for (const [ext, expectedId] of cases) {
      const resolved = index.resolveByExtension(ext);
      expect(resolved?.id).toBe(expectedId);
    }
  });

  it('normalizes extension casing', () => {
    expect(index.resolveByExtension('.TS')?.id).toBe('typescript');
    expect(index.resolveByExtension('.Go')?.id).toBe('go');
  });

  it('returns null for unknown extensions', () => {
    expect(index.resolveByExtension('.rs')).toBeNull();
    expect(index.resolveByExtension('.unknownext')).toBeNull();
  });

  it('returns null when file has no extension', () => {
    expect(resolveContributionForFile(index, '/path/to/Makefile')).toBeNull();
  });

  it('resolves file paths ignoring trailing dots inside directory names', () => {
    const resolved = resolveContributionForFile(index, '/src/foo.bar/entry.ts');
    expect(resolved?.id).toBe('typescript');
  });

  it('does not treat dotfiles as having an extension', () => {
    expect(resolveContributionForFile(index, '/home/u/.bashrc')).toBeNull();
    expect(resolveContributionForFile(index, '.gitignore')).toBeNull();
    expect(resolveContributionForFile(index, '.env')).toBeNull();
  });
});

describe('ExtensionIndex plugin overrides', () => {
  it('replaces builtin with plugin contribution of same id', () => {
    const customTs = makeContribution('typescript', [
      '.ts',
    ]);
    const merged = createExtensionIndex([
      ...createBuiltinLspServers(),
      customTs,
    ]);
    const resolved = merged.resolveByExtension('.ts');
    expect(resolved).toBe(customTs);
  });

  it('adds a novel extension from a plugin contribution', () => {
    const rustServer = makeContribution('rust-analyzer', [
      '.rs',
    ]);
    const merged = createExtensionIndex([
      ...createBuiltinLspServers(),
      rustServer,
    ]);
    expect(merged.resolveByExtension('.rs')?.id).toBe('rust-analyzer');
    // Builtins remain untouched
    expect(merged.resolveByExtension('.ts')?.id).toBe('typescript');
  });

  it('first-registered wins when different contributions claim the same extension', () => {
    const first = makeContribution('a', [
      '.rb',
    ]);
    const second = makeContribution('b', [
      '.rb',
    ]);
    const index = createExtensionIndex([
      first,
      second,
    ]);
    expect(index.resolveByExtension('.rb')?.id).toBe('a');
  });

  it('exposes all merged contributions via list()', () => {
    const rust = makeContribution('rust-analyzer', [
      '.rs',
    ]);
    const merged = createExtensionIndex([
      ...createBuiltinLspServers(),
      rust,
    ]);
    const ids = merged.list().map((c) => c.id);
    expect(ids).toContain('typescript');
    expect(ids).toContain('rust-analyzer');
  });
});
