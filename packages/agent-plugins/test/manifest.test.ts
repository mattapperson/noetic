/** Agent Plugins §5 (manifest) and §8.1 (extension data). */

import { describe, expect, test } from 'bun:test';
import { DiagnosticCode } from '../src/diagnostics';
import {
  NOETIC_EXTENSION_NAMESPACE,
  PLUGIN_SCHEMA_ID,
  readExtension,
  validateManifest,
} from '../src/manifest';

const DIR = '/plugins/example';

function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: PLUGIN_SCHEMA_ID,
    name: 'example',
    ...extra,
  };
}

describe('§5.3 required fields', () => {
  test('accepts a minimal manifest', () => {
    const result = validateManifest(base(), DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.name).toBe('example');
    expect(result.diagnostics).toHaveLength(0);
  });

  test('rejects a missing name', () => {
    const result = validateManifest(
      {
        $schema: PLUGIN_SCHEMA_ID,
      },
      DIR,
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.PluginRejected);
  });

  test('rejects a missing $schema', () => {
    const result = validateManifest(
      {
        name: 'example',
      },
      DIR,
    );
    expect(result.ok).toBe(false);
  });

  test('rejects a non-object document', () => {
    for (const value of [
      null,
      42,
      'text',
      [],
    ]) {
      expect(validateManifest(value, DIR).ok).toBe(false);
    }
  });
});

describe('§5.2 $schema version gate', () => {
  test('rejects an unsupported version rather than fetching it', () => {
    const result = validateManifest(
      base({
        $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json',
      }),
      DIR,
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.detail).toContain('unsupported Agent Plugins version');
  });
});

describe('§5.5 name constraints', () => {
  const valid = [
    'my-plugin',
    'acme.tools',
    'lint3r',
    'a',
    '0',
  ];
  for (const name of valid) {
    test(`accepts '${name}'`, () => {
      expect(
        validateManifest(
          base({
            name,
          }),
          DIR,
        ).ok,
      ).toBe(true);
    });
  }

  const invalid: Array<
    [
      string,
      string,
    ]
  > = [
    [
      'My-Plugin',
      'uppercase',
    ],
    [
      '-start',
      'leading hyphen',
    ],
    [
      'end-',
      'trailing hyphen',
    ],
    [
      '.start',
      'leading period',
    ],
    [
      'has--double',
      'consecutive hyphens',
    ],
    [
      'too.many..dots',
      'consecutive periods',
    ],
    [
      '',
      'empty',
    ],
    [
      'has_underscore',
      'illegal character',
    ],
  ];
  for (const [name, why] of invalid) {
    test(`rejects '${name}' (${why})`, () => {
      expect(
        validateManifest(
          base({
            name,
          }),
          DIR,
        ).ok,
      ).toBe(false);
    });
  }

  test('accepts exactly 64 characters and rejects 65', () => {
    expect(
      validateManifest(
        base({
          name: 'a'.repeat(64),
        }),
        DIR,
      ).ok,
    ).toBe(true);
    expect(
      validateManifest(
        base({
          name: 'a'.repeat(65),
        }),
        DIR,
      ).ok,
    ).toBe(false);
  });
});

describe('§5.2 unknown top-level fields', () => {
  test('reports and ignores them, and the plugin still loads', () => {
    const result = validateManifest(
      base({
        commands: './commands',
        hooks: {},
      }),
      DIR,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.every((d) => d.code === DiagnosticCode.UnknownManifestField)).toBe(
      true,
    );
    expect(result.diagnostics.map((d) => d.detail).join(' ')).toContain('commands');
    // The ignored field must not survive into the validated manifest.
    expect(Object.keys(result.manifest)).not.toContain('commands');
  });
});

describe('§5.4 metadata fields', () => {
  test('accepts all optional fields', () => {
    const result = validateManifest(
      base({
        version: '1.2.0',
        description: 'Brief plugin description',
        author: {
          name: 'Author Name',
          email: 'author@example.com',
          url: 'https://example.com',
        },
        homepage: 'https://docs.example.com/plugin',
        repository: 'https://github.com/example/plugin',
        license: 'MIT',
        keywords: [
          'keyword1',
          'keyword2',
        ],
      }),
      DIR,
    );
    expect(result.ok).toBe(true);
  });

  test('does not reject a non-semver version or a non-URL homepage', () => {
    const result = validateManifest(
      base({
        version: 'not-semver',
        homepage: 'not a url',
        license: 'not-an-spdx-id',
        author: {
          email: 'not-an-email',
        },
      }),
      DIR,
    );
    expect(result.ok).toBe(true);
  });

  test('rejects an author field outside name/email/url', () => {
    const result = validateManifest(
      base({
        author: {
          name: 'A',
          twitter: '@a',
        },
      }),
      DIR,
    );
    expect(result.ok).toBe(false);
  });

  test('rejects a non-string keyword', () => {
    expect(
      validateManifest(
        base({
          keywords: [
            'ok',
            7,
          ],
        }),
        DIR,
      ).ok,
    ).toBe(false);
  });
});

describe('§8.1 extensions', () => {
  test('reports and ignores a non-object extensions field', () => {
    const result = validateManifest(
      base({
        extensions: 'nope',
      }),
      DIR,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.InvalidExtensions);
    expect(result.manifest.extensions).toBeUndefined();
  });

  test('rejects a namespace whose value is not an object', () => {
    const result = validateManifest(
      base({
        extensions: {
          'com.example.client': 'nope',
        },
      }),
      DIR,
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.detail).toContain('com.example.client');
  });

  test('carries unimplemented namespaces through without validating them', () => {
    const result = validateManifest(
      base({
        extensions: {
          'com.example.client': {
            anything: [
              1,
              2,
              3,
            ],
            nested: {
              deep: true,
            },
          },
        },
      }),
      DIR,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(readExtension(result.manifest, 'com.example.client')).toEqual({
      anything: [
        1,
        2,
        3,
      ],
      nested: {
        deep: true,
      },
    });
  });

  test('reads the tools.noetic namespace Noetic claims', () => {
    const result = validateManifest(
      base({
        extensions: {
          [NOETIC_EXTENSION_NAMESPACE]: {
            setting: true,
          },
        },
      }),
      DIR,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(readExtension(result.manifest, NOETIC_EXTENSION_NAMESPACE)).toEqual({
      setting: true,
    });
    expect(readExtension(result.manifest, 'tools.absent')).toBeUndefined();
  });
});
