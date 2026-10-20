/** Agent Plugins §7.2 (MCP configuration), §9.2 (placeholder expansion), §10.1 (version match). */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SPEC_VERSION } from '../src/manifest';
import {
  expandPlaceholders,
  MCP_SCHEMA_ID,
  parseMcpDocument,
  resolveMcpServer,
  validateMcpEntry,
} from '../src/mcp-config';
import { cleanupFixtures, tempDir } from './_helpers';

afterAll(cleanupFixtures);

// Composed rather than written out, so nothing here is mistaken for an
// interpolation by a reader or a linter.
const ROOT_VAR = `\${${'PLUGIN_ROOT'}}`;
const DATA_VAR = `\${${'PLUGIN_DATA'}}`;

//#region Document

describe('§7.2.1 document shape', () => {
  test('accepts a document with an empty mcpServers object', () => {
    const result = parseMcpDocument(
      {
        $schema: MCP_SCHEMA_ID,
        mcpServers: {},
      },
      SPEC_VERSION,
    );
    expect(result.ok).toBe(true);
  });

  test('rejects an extra top-level field', () => {
    const result = parseMcpDocument(
      {
        $schema: MCP_SCHEMA_ID,
        mcpServers: {},
        extra: true,
      },
      SPEC_VERSION,
    );
    expect(result.ok).toBe(false);
  });

  test('rejects a missing mcpServers', () => {
    expect(
      parseMcpDocument(
        {
          $schema: MCP_SCHEMA_ID,
        },
        SPEC_VERSION,
      ).ok,
    ).toBe(false);
  });

  test('rejects a $schema that is not a canonical identifier', () => {
    const result = parseMcpDocument(
      {
        $schema: 'https://example.com/mcp.json',
        mcpServers: {},
      },
      SPEC_VERSION,
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.detail).toContain('canonical');
  });
});

describe('§10.1 version match with plugin.json', () => {
  test('rejects an mcp.json targeting a different spec version', () => {
    const result = parseMcpDocument(
      {
        $schema: 'https://agent-plugins.org/schemas/2.0.0/mcp.schema.json',
        mcpServers: {},
      },
      SPEC_VERSION,
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.detail).toContain('§10.1');
  });
});

//#endregion

//#region Entries

describe('§7.2.1 closed server union', () => {
  test('accepts a minimal stdio entry', () => {
    expect(
      validateMcpEntry({
        type: 'stdio',
        command: 'npx',
      }).ok,
    ).toBe(true);
  });

  test('accepts a minimal streamable-http entry', () => {
    expect(
      validateMcpEntry({
        type: 'streamable-http',
        url: 'https://deploy.example.com/mcp',
      }).ok,
    ).toBe(true);
  });

  test('accepts an sse entry', () => {
    expect(
      validateMcpEntry({
        type: 'sse',
        url: 'https://legacy.example.com/sse',
      }).ok,
    ).toBe(true);
  });

  test('rejects an unknown type', () => {
    expect(
      validateMcpEntry({
        type: 'websocket',
        url: 'wss://example.com',
      }).ok,
    ).toBe(false);
  });

  test('rejects an unknown field', () => {
    expect(
      validateMcpEntry({
        type: 'stdio',
        command: 'npx',
        timeout: 30,
      }).ok,
    ).toBe(false);
  });

  test('rejects a field belonging to another variant', () => {
    expect(
      validateMcpEntry({
        type: 'stdio',
        command: 'npx',
        url: 'https://example.com/mcp',
      }).ok,
    ).toBe(false);
    expect(
      validateMcpEntry({
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        command: 'npx',
      }).ok,
    ).toBe(false);
  });

  test('rejects a missing required field', () => {
    expect(
      validateMcpEntry({
        type: 'stdio',
      }).ok,
    ).toBe(false);
    expect(
      validateMcpEntry({
        type: 'sse',
      }).ok,
    ).toBe(false);
  });
});

describe("§7.2.1 stdio 'command' is one token", () => {
  test('accepts a bare executable name', () => {
    expect(
      validateMcpEntry({
        type: 'stdio',
        command: 'npx',
      }).ok,
    ).toBe(true);
  });

  test('accepts a plugin-relative path', () => {
    expect(
      validateMcpEntry({
        type: 'stdio',
        command: './bin/validator',
      }).ok,
    ).toBe(true);
  });

  test('rejects a shell command string', () => {
    const result = validateMcpEntry({
      type: 'stdio',
      command: 'npx -y some-server',
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.detail).toContain('single executable token');
  });

  test('rejects shell metacharacters', () => {
    for (const command of [
      'sh -c "x"',
      'a|b',
      'a;b',
      'a&&b',
      '$(whoami)',
    ]) {
      expect(
        validateMcpEntry({
          type: 'stdio',
          command,
        }).ok,
      ).toBe(false);
    }
  });

  test("rejects a path that is neither bare nor './'-prefixed", () => {
    expect(
      validateMcpEntry({
        type: 'stdio',
        command: 'bin/validator',
      }).ok,
    ).toBe(false);
    expect(
      validateMcpEntry({
        type: 'stdio',
        command: '../bin/validator',
      }).ok,
    ).toBe(false);
    expect(
      validateMcpEntry({
        type: 'stdio',
        command: '/usr/bin/validator',
      }).ok,
    ).toBe(false);
  });
});

describe("§7.2.1 stdio 'cwd' forms", () => {
  const legal = [
    './data',
    ROOT_VAR,
    `${ROOT_VAR}/nested`,
    DATA_VAR,
    `${DATA_VAR}/cache`,
  ];
  for (const cwd of legal) {
    test(`accepts '${cwd}'`, () => {
      expect(
        validateMcpEntry({
          type: 'stdio',
          command: 'npx',
          cwd,
        }).ok,
      ).toBe(true);
    });
  }

  const illegal = [
    'data',
    '/absolute',
    '../escape',
    `${ROOT_VAR}suffix`,
  ];
  for (const cwd of illegal) {
    test(`rejects '${cwd}'`, () => {
      expect(
        validateMcpEntry({
          type: 'stdio',
          command: 'npx',
          cwd,
        }).ok,
      ).toBe(false);
    });
  }
});

describe('§9.2 reserved environment variables', () => {
  test('rejects an env entry named PLUGIN_ROOT', () => {
    const result = validateMcpEntry({
      type: 'stdio',
      command: 'npx',
      env: {
        PLUGIN_ROOT: '/somewhere',
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.detail).toContain('PLUGIN_ROOT');
  });

  test('rejects an env entry named PLUGIN_DATA', () => {
    expect(
      validateMcpEntry({
        type: 'stdio',
        command: 'npx',
        env: {
          PLUGIN_DATA: '/somewhere',
        },
      }).ok,
    ).toBe(false);
  });
});

describe('§7.2.1 remote url requirements', () => {
  test('rejects a relative url', () => {
    expect(
      validateMcpEntry({
        type: 'streamable-http',
        url: '/mcp',
      }).ok,
    ).toBe(false);
  });

  test('rejects a non-http scheme', () => {
    expect(
      validateMcpEntry({
        type: 'streamable-http',
        url: 'ws://example.com/mcp',
      }).ok,
    ).toBe(false);
  });

  test('rejects user information', () => {
    expect(
      validateMcpEntry({
        type: 'streamable-http',
        url: 'https://user:pass@example.com/mcp',
      }).ok,
    ).toBe(false);
  });

  test('rejects a fragment', () => {
    expect(
      validateMcpEntry({
        type: 'streamable-http',
        url: 'https://example.com/mcp#frag',
      }).ok,
    ).toBe(false);
  });

  test('rejects plain HTTP off loopback', () => {
    expect(
      validateMcpEntry({
        type: 'streamable-http',
        url: 'http://example.com/mcp',
      }).ok,
    ).toBe(false);
  });

  test('accepts plain HTTP on loopback hosts', () => {
    for (const url of [
      'http://localhost:3000/mcp',
      'http://127.0.0.1:3000/mcp',
      'http://[::1]:3000/mcp',
    ]) {
      expect(
        validateMcpEntry({
          type: 'streamable-http',
          url,
        }).ok,
      ).toBe(true);
    }
  });
});

describe('§7.2.1 headers', () => {
  test('accepts valid headers', () => {
    expect(
      validateMcpEntry({
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: {
          'X-Tenant': 'public-tenant',
        },
      }).ok,
    ).toBe(true);
  });

  test('rejects the same name under different casing', () => {
    const result = validateMcpEntry({
      type: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: {
        'X-Tenant': 'a',
        'x-tenant': 'b',
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.detail).toContain('different casing');
  });

  test('rejects an illegal field name', () => {
    expect(
      validateMcpEntry({
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: {
          'X Tenant': 'a',
        },
      }).ok,
    ).toBe(false);
  });

  test('rejects a value carrying a newline', () => {
    expect(
      validateMcpEntry({
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: {
          'X-Tenant': 'a\r\nX-Injected: b',
        },
      }).ok,
    ).toBe(false);
  });

  test('accepts a tab inside a value', () => {
    expect(
      validateMcpEntry({
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: {
          'X-Tenant': 'a\tb',
        },
      }).ok,
    ).toBe(true);
  });
});

//#endregion

//#region Expansion

describe('§9.2 placeholder expansion', () => {
  const vars = {
    pluginRoot: '/plugins/devtools',
    pluginData: '/data/devtools',
  };

  test('replaces every occurrence of both placeholders', () => {
    expect(expandPlaceholders(`${ROOT_VAR}/a:${DATA_VAR}/b:${ROOT_VAR}`, vars)).toBe(
      '/plugins/devtools/a:/data/devtools/b:/plugins/devtools',
    );
  });

  test('leaves unrecognized placeholder-like text literal', () => {
    const input = `\${${'HOME'}}/x`;
    expect(expandPlaceholders(input, vars)).toBe(input);
  });

  test('does not rescan replacement text', () => {
    // The replacement itself contains a placeholder; a recursive expander
    // would substitute it a second time.
    const recursive = {
      pluginRoot: DATA_VAR,
      pluginData: '/data',
    };
    expect(expandPlaceholders(ROOT_VAR, recursive)).toBe(DATA_VAR);
  });
});

//#endregion

//#region Resolution

describe('§4.1 + §9.2 resolution', () => {
  test('expands args, env values, and cwd but never command or env keys', async () => {
    const base = await tempDir();
    const pluginRoot = join(base, 'plugin');
    const pluginData = join(base, 'data');
    await mkdir(join(pluginRoot, 'bin'), {
      recursive: true,
    });
    await mkdir(pluginData, {
      recursive: true,
    });
    await writeFile(join(pluginRoot, 'bin', 'validator'), '#!/bin/sh\n', 'utf8');

    const result = await resolveMcpServer({
      key: 'p/local',
      config: {
        type: 'stdio',
        command: './bin/validator',
        args: [
          '--data',
          `${DATA_VAR}/validator`,
        ],
        env: {
          [`CONFIG${ROOT_VAR}`]: `${ROOT_VAR}/config.json`,
        },
        cwd: ROOT_VAR,
      },
      vars: {
        pluginRoot,
        pluginData,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.server.type !== 'stdio') {
      return;
    }
    expect(result.server.command).toBe(join(pluginRoot, 'bin', 'validator'));
    expect(result.server.args).toEqual([
      '--data',
      `${pluginData}/validator`,
    ]);
    // The key keeps its literal placeholder; only the value expands.
    expect(Object.keys(result.server.env)).toEqual([
      `CONFIG${ROOT_VAR}`,
    ]);
    expect(result.server.env[`CONFIG${ROOT_VAR}`]).toBe(`${pluginRoot}/config.json`);
    expect(result.server.cwd).toBe(pluginRoot);
    // §9.1: the reserved variables are applied at launch, not here.
    expect(result.server.env.PLUGIN_ROOT).toBeUndefined();
  });

  test('defaults cwd to the plugin root when omitted', async () => {
    const base = await tempDir();
    const pluginRoot = join(base, 'plugin');
    await mkdir(pluginRoot, {
      recursive: true,
    });

    const result = await resolveMcpServer({
      key: 'p/local',
      config: {
        type: 'stdio',
        command: 'npx',
      },
      vars: {
        pluginRoot,
        pluginData: join(base, 'data'),
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.server.type !== 'stdio') {
      return;
    }
    expect(result.server.cwd).toBe(pluginRoot);
    expect(result.server.command).toBe('npx');
  });

  test('rejects a command escaping the plugin root through a symlink', async () => {
    const base = await tempDir();
    const pluginRoot = join(base, 'plugin');
    const outside = join(base, 'outside');
    await mkdir(join(pluginRoot, 'bin'), {
      recursive: true,
    });
    await mkdir(outside, {
      recursive: true,
    });
    await writeFile(join(outside, 'evil'), '#!/bin/sh\n', 'utf8');
    const { symlink } = await import('node:fs/promises');
    await symlink(join(outside, 'evil'), join(pluginRoot, 'bin', 'evil'), 'file');

    const result = await resolveMcpServer({
      key: 'p/evil',
      config: {
        type: 'stdio',
        command: './bin/evil',
      },
      vars: {
        pluginRoot,
        pluginData: join(base, 'data'),
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.detail).toContain('§4.1');
  });

  test('contains a PLUGIN_DATA-rooted cwd against the data directory', async () => {
    const base = await tempDir();
    const pluginRoot = join(base, 'plugin');
    const pluginData = join(base, 'data');
    await mkdir(pluginRoot, {
      recursive: true,
    });
    await mkdir(join(pluginData, 'cache'), {
      recursive: true,
    });

    const result = await resolveMcpServer({
      key: 'p/local',
      config: {
        type: 'stdio',
        command: 'npx',
        cwd: `${DATA_VAR}/cache`,
      },
      vars: {
        pluginRoot,
        pluginData,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.server.type !== 'stdio') {
      return;
    }
    expect(result.server.cwd).toBe(join(pluginData, 'cache'));
  });

  test('passes remote entries through without expansion', async () => {
    const result = await resolveMcpServer({
      key: 'p/remote',
      config: {
        type: 'streamable-http',
        url: 'https://deploy.example.com/mcp',
        headers: {
          'X-Tenant': ROOT_VAR,
        },
      },
      vars: {
        pluginRoot: '/plugins/p',
        pluginData: '/data/p',
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.server.type === 'stdio') {
      return;
    }
    expect(result.server.url).toBe('https://deploy.example.com/mcp');
    expect(result.server.headers['X-Tenant']).toBe(ROOT_VAR);
  });
});

//#endregion
