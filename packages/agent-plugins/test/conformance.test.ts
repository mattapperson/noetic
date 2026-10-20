/**
 * Agent Plugins v1.0.0 Appendix A — the conformance checklist, one test per
 * checkbox, driven by real plugin trees on disk.
 *
 * This file is the evidence that `@noetic-tools/agent-plugins` is a conformant
 * client. Each `test` name names the requirement and cites its section.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DiagnosticCode } from '../src/diagnostics';
import { discoverPlugins } from '../src/discovery';
import { agentPlugins } from '../src/layer/agent-plugins';
import { PLUGIN_SCHEMA_ID } from '../src/manifest';
import { buildSubprocessEnv, connectMcpServer } from '../src/mcp-client';
import { McpTransport, resolveMcpServer } from '../src/mcp-config';
import {
  cleanupFixtures,
  fakeExecutionContext,
  linkFixture,
  makePluginRoot,
  makeScopedStorage,
  manifest,
  mcpConfig,
  skillDoc,
  tempDir,
} from './_helpers';

afterAll(cleanupFixtures);

const ROOT_VAR = `\${${'PLUGIN_ROOT'}}`;
const DATA_VAR = `\${${'PLUGIN_DATA'}}`;

//#region Plugin loader

describe('Appendix A — plugin loader', () => {
  test('parses and validates plugin.json (§5.1, §5.2)', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('valid'),
      },
    ]);
    const { plugins } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(plugins.map((p) => p.manifest.name)).toEqual([
      'valid',
    ]);
  });

  test('validates the required $schema and name fields (§5.3)', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        dir: 'no-schema',
        manifest: JSON.stringify({
          name: 'no-schema',
        }),
      },
      {
        dir: 'no-name',
        manifest: JSON.stringify({
          $schema: PLUGIN_SCHEMA_ID,
        }),
      },
    ]);
    const { plugins, diagnostics } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(plugins).toHaveLength(0);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((d) => d.code === DiagnosticCode.PluginRejected)).toBe(true);
  });

  test('validates the plugin name against §5.5 and executes nothing when it fails', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        dir: 'bad-name',
        manifest: JSON.stringify({
          $schema: PLUGIN_SCHEMA_ID,
          name: 'has--double',
        }),
        skills: {
          deploy: skillDoc({
            name: 'deploy',
          }),
        },
        mcp: mcpConfig({
          api: {
            type: 'streamable-http',
            url: 'https://example.com/mcp',
          },
        }),
      },
    ]);
    const { plugins } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    // §11.3 rule 2: no component of a rejected plugin is discovered.
    expect(plugins).toHaveLength(0);
  });

  test('reports and ignores unknown plugin.json fields (§5.2)', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p', {
          commands: './commands',
          agents: './agents',
        }),
        skills: {
          deploy: skillDoc({
            name: 'deploy',
          }),
        },
      },
    ]);
    const { plugins, diagnostics } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.skills).toHaveLength(1);
    expect(diagnostics.filter((d) => d.code === DiagnosticCode.UnknownManifestField)).toHaveLength(
      2,
    );
  });

  test('ignores unimplemented extension namespaces without validating them (§8.1)', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p', {
          extensions: {
            'com.example.client': {
              // Deliberately shaped like nothing this client understands.
              deeply: {
                nested: [
                  1,
                  null,
                  false,
                ],
              },
            },
          },
        }),
      },
    ]);
    const { plugins, diagnostics } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(plugins).toHaveLength(1);
    expect(diagnostics).toHaveLength(0);
  });

  test('rejects package paths resolving outside the plugin root (§4.1)', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
        skills: {
          good: skillDoc({
            name: 'good',
          }),
        },
      },
    ]);
    const outside = await tempDir();
    await writeFile(
      join(outside, 'SKILL.md'),
      skillDoc({
        name: 'escaped',
      }),
      'utf8',
    );
    await linkFixture(join(root, 'p', 'skills', 'escaped'), outside, 'dir');

    const { plugins, diagnostics } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(plugins[0]?.skills.map((s) => s.id)).toEqual([
      'good',
    ]);
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.SkillSkipped && d.component === 'escaped'),
    ).toBe(true);
  });

  test('discovers the implemented extension directory from its top-level namespace (§8.2)', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
        files: {
          'tools.noetic/hooks/hooks.json': '{}',
        },
      },
    ]);
    const { plugins } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(plugins[0]?.noeticExtensionDir).toBe(join(plugins[0]?.root ?? '', 'tools.noetic'));
  });
});

//#endregion

//#region Component discovery

describe('Appendix A — component discovery', () => {
  test('scans the fixed location for each supported component type (§6.1)', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('reports-plugin'),
        skills: {
          summarize: skillDoc({
            name: 'summarize',
          }),
        },
        mcp: mcpConfig({
          api: {
            type: 'stdio',
            command: 'npx',
          },
        }),
      },
    ]);
    const { plugins } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(plugins[0]?.skills.map((s) => s.id)).toEqual([
      'summarize',
    ]);
    expect(plugins[0]?.mcpServers.map((s) => s.key)).toEqual([
      'api',
    ]);
  });

  test('ignores missing fixed locations without error (§6.2)', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('empty'),
      },
    ]);
    const { plugins, diagnostics } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(plugins).toHaveLength(1);
    expect(diagnostics).toHaveLength(0);
  });

  test('does not recurse below the immediate children of skills/ (§7.1)', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
        files: {
          'skills/outer/inner/SKILL.md': skillDoc({
            name: 'inner',
          }),
        },
      },
    ]);
    const { plugins } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(plugins[0]?.skills).toHaveLength(0);
  });
});

//#endregion

//#region MCP configuration

describe('Appendix A — MCP configuration', () => {
  test('disables MCP for the plugin when mcp.json is invalid, keeping skills (§7.2.2 rule 2)', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
        skills: {
          deploy: skillDoc({
            name: 'deploy',
          }),
        },
        mcp: '{ not json',
      },
    ]);
    const { plugins, diagnostics } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(plugins[0]?.skills).toHaveLength(1);
    expect(plugins[0]?.mcpServers).toHaveLength(0);
    expect(diagnostics.some((d) => d.code === DiagnosticCode.McpDisabled)).toBe(true);
  });

  test('disables MCP when mcp.json targets a different spec version than plugin.json (§10.1)', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
        skills: {
          deploy: skillDoc({
            name: 'deploy',
          }),
        },
        mcp: mcpConfig(
          {
            api: {
              type: 'streamable-http',
              url: 'https://example.com/mcp',
            },
          },
          'https://agent-plugins.org/schemas/2.0.0/mcp.schema.json',
        ),
      },
    ]);
    const { plugins, diagnostics } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(plugins[0]?.skills).toHaveLength(1);
    expect(plugins[0]?.mcpServers).toHaveLength(0);
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.McpDisabled && d.detail.includes('§10.1')),
    ).toBe(true);
  });

  test('skips one invalid server entry and keeps its siblings (§7.2.2 rule 3)', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
        mcp: mcpConfig({
          broken: {
            type: 'stdio',
            command: '../escape/server',
          },
          fine: {
            type: 'streamable-http',
            url: 'https://example.com/mcp',
          },
        }),
      },
    ]);
    const { plugins, diagnostics } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(plugins[0]?.mcpServers.map((s) => s.key)).toEqual([
      'fine',
    ]);
    expect(
      diagnostics.some(
        (d) => d.code === DiagnosticCode.McpServerInvalid && d.component === 'broken',
      ),
    ).toBe(true);
  });

  test('skips an entry whose transport the host has not enabled (§7.2.2 rule 4)', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
        mcp: mcpConfig({
          legacy: {
            type: 'sse',
            url: 'https://legacy.example.com/sse',
          },
        }),
      },
    ]);
    const layer = agentPlugins({
      roots: [
        root,
      ],
      dataDir,
      // The default transport set omits the deprecated SSE transport.
      transports: [
        McpTransport.Stdio,
        McpTransport.StreamableHttp,
      ],
    });
    const { ctx } = fakeExecutionContext();
    await layer.hooks.init?.({
      storage: makeScopedStorage(),
      scopeKey: 'thread:test',
      ctx,
    });

    expect(layer.readMcpTools()).toHaveLength(0);
    expect(
      layer.readDiagnostics().some((d) => d.code === DiagnosticCode.McpTransportUnsupported),
    ).toBe(true);
  });

  test('rejects an env entry named after a reserved variable (§9.2)', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
        mcp: mcpConfig({
          bad: {
            type: 'stdio',
            command: 'npx',
            env: {
              PLUGIN_ROOT: '/spoofed',
            },
          },
        }),
      },
    ]);
    const { plugins, diagnostics } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(plugins[0]?.mcpServers).toHaveLength(0);
    expect(diagnostics.some((d) => d.code === DiagnosticCode.McpServerInvalid)).toBe(true);
  });
});

//#endregion

//#region Environment and expansion

describe('Appendix A — environment and expansion', () => {
  test('sets PLUGIN_ROOT and PLUGIN_DATA after the configured env, replacing it (§9.1)', () => {
    const env = buildSubprocessEnv({
      server: {
        key: 'p/s',
        type: McpTransport.Stdio,
        command: 'node',
        args: [],
        env: {
          CONFIG: '/from/plugin',
        },
        cwd: '/plugins/p',
      },
      pluginRoot: '/plugins/p',
      pluginData: '/data/p',
      baseEnv: {
        PATH: '/usr/bin',
        // A base value the plugin's own env must be able to override.
        CONFIG: '/from/base',
        // A secret-shaped ambient variable that must not reach the plugin.
        OPENROUTER_API_KEY: 'sk-secret',
      },
    });

    expect(env.PLUGIN_ROOT).toBe('/plugins/p');
    expect(env.PLUGIN_DATA).toBe('/data/p');
    expect(env.CONFIG).toBe('/from/plugin');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  test('resolves command as a single bare or plugin-relative token (§7.2.1)', async () => {
    const base = await tempDir();
    const pluginRoot = join(base, 'p');
    await mkdir(join(pluginRoot, 'bin'), {
      recursive: true,
    });
    await writeFile(join(pluginRoot, 'bin', 'server'), '#!/bin/sh\n', 'utf8');

    const relative = await resolveMcpServer({
      key: 'p/s',
      config: {
        type: 'stdio',
        command: './bin/server',
      },
      vars: {
        pluginRoot,
        pluginData: join(base, 'data'),
      },
    });
    expect(relative.ok).toBe(true);
    if (relative.ok && relative.server.type === McpTransport.Stdio) {
      expect(relative.server.command).toBe(join(pluginRoot, 'bin', 'server'));
    }

    const bare = await resolveMcpServer({
      key: 'p/s',
      config: {
        type: 'stdio',
        command: 'npx',
      },
      vars: {
        pluginRoot,
        pluginData: join(base, 'data'),
      },
    });
    expect(bare.ok).toBe(true);
    if (bare.ok && bare.server.type === McpTransport.Stdio) {
      // A bare name is left for the platform executable search.
      expect(bare.server.command).toBe('npx');
    }
  });

  test('expands only the two plugin variables, and only in args, env values, and cwd (§9.2)', async () => {
    const base = await tempDir();
    const pluginRoot = join(base, 'p');
    const pluginData = join(base, 'data');
    await mkdir(pluginRoot, {
      recursive: true,
    });
    await mkdir(pluginData, {
      recursive: true,
    });

    const result = await resolveMcpServer({
      key: 'p/s',
      config: {
        type: 'stdio',
        command: 'npx',
        args: [
          `${ROOT_VAR}/a`,
          `${DATA_VAR}/b`,
          `\${${'HOME'}}/c`,
        ],
        env: {
          FROM_ROOT: `${ROOT_VAR}/config.json`,
          UNTOUCHED: `\${${'SHELL'}}`,
        },
        cwd: DATA_VAR,
      },
      vars: {
        pluginRoot,
        pluginData,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.server.type !== McpTransport.Stdio) {
      return;
    }
    expect(result.server.args).toEqual([
      `${pluginRoot}/a`,
      `${pluginData}/b`,
      // Unrecognized placeholder-like text stays literal.
      `\${${'HOME'}}/c`,
    ]);
    expect(result.server.env.FROM_ROOT).toBe(`${pluginRoot}/config.json`);
    expect(result.server.env.UNTOUCHED).toBe(`\${${'SHELL'}}`);
    expect(result.server.cwd).toBe(pluginData);
  });
});

//#endregion

//#region Resilience

describe('Appendix A — resilience', () => {
  test('continues loading when an independent component fails (§11.3 rule 3)', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
        skills: {
          good: skillDoc({
            name: 'good',
          }),
          bad: skillDoc({
            name: 'wrong-name',
          }),
        },
        mcp: mcpConfig({
          broken: {
            type: 'stdio',
            command: 'sh -c "evil"',
          },
          fine: {
            type: 'streamable-http',
            url: 'https://example.com/mcp',
          },
        }),
      },
    ]);
    const { plugins, diagnostics } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(plugins[0]?.skills.map((s) => s.id)).toEqual([
      'good',
    ]);
    expect(plugins[0]?.mcpServers.map((s) => s.key)).toEqual([
      'fine',
    ]);
    // Both failures are reported, neither is silent.
    expect(diagnostics.map((d) => d.code).sort()).toEqual([
      DiagnosticCode.McpServerInvalid,
      DiagnosticCode.SkillSkipped,
    ]);
  });

  test('reports a connection failure without disturbing other components (§7.2.2 rule 5)', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
        skills: {
          good: skillDoc({
            name: 'good',
          }),
        },
        mcp: mcpConfig({
          // A bare command that will not resolve on any platform search.
          missing: {
            type: 'stdio',
            command: 'noetic-agent-plugins-no-such-executable',
          },
        }),
      },
    ]);
    const layer = agentPlugins({
      roots: [
        root,
      ],
      dataDir,
    });
    const { ctx } = fakeExecutionContext();
    await layer.hooks.init?.({
      storage: makeScopedStorage(),
      scopeKey: 'thread:test',
      ctx,
    });

    expect(layer.readPlugins()[0]?.skills).toHaveLength(1);
    expect(layer.readMcpTools()).toHaveLength(0);
    expect(layer.readDiagnostics().some((d) => d.code === DiagnosticCode.McpConnectFailed)).toBe(
      true,
    );
    await layer.hooks.dispose?.({
      state: {
        activated: [],
      },
    });
  });
});

//#endregion

//#region Appendix A boxes with no other home

describe('Appendix A — remaining boxes', () => {
  test('ignores component types outside v1 (§11.3 rule 1)', async () => {
    // A plugin may ship directories for component types this spec version does
    // not define (commands, hooks, agents). They must be neither loaded nor
    // complained about — silence is the required behavior, not an oversight.
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
        skills: {
          real: skillDoc({
            name: 'real',
          }),
        },
        files: {
          'commands/deploy.md': '# not a v1 component type',
          'hooks/hooks.json': '{}',
          'agents/reviewer.md': '# nor this',
        },
      },
    ]);
    const { plugins, diagnostics } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(plugins[0]?.skills.map((s) => s.id)).toEqual([
      'real',
    ]);
    expect(diagnostics).toHaveLength(0);
  });

  test('resolves a bare command without a configured PATH (§7.2.1)', async () => {
    // §7.2.1 leaves bare-command resolution to the platform search and forbids
    // a conforming plugin from depending on a configured PATH. So a bare
    // command must launch when the plugin configures no PATH at all.
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('bare'),
        files: {
          'bin/server.mjs': FIXTURE_SERVER,
        },
        mcp: mcpConfig({
          fixture: {
            type: 'stdio',
            command: 'node',
            args: [
              `${ROOT_VAR}/bin/server.mjs`,
            ],
          },
        }),
      },
    ]);
    const layer = agentPlugins({
      roots: [
        root,
      ],
      dataDir,
    });
    const { ctx } = fakeExecutionContext();
    await layer.hooks.init?.({
      storage: makeScopedStorage(),
      scopeKey: 'thread:test',
      ctx,
    });
    try {
      expect(layer.readMcpTools().map((t) => t.name)).toEqual([
        'echo_env',
      ]);
    } finally {
      await layer.hooks.dispose?.({
        state: {
          activated: [],
        },
      });
    }
  }, 20_000);

  test('uses the declared transport for the initial attempt (§7.2.1)', async () => {
    // A `streamable-http` entry must go out over HTTP, not be coerced into
    // some other transport. Proven by a loopback server observing the request
    // rather than by inspecting which class was constructed.
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(`${request.method} ${new URL(request.url).pathname}`);
        return new Response('no', {
          status: 500,
        });
      },
    });

    try {
      const { root, dataDir } = await makePluginRoot([
        {
          manifest: manifest('remote'),
          mcp: mcpConfig({
            api: {
              type: 'streamable-http',
              url: `http://127.0.0.1:${server.port}/mcp`,
            },
          }),
        },
      ]);
      const layer = agentPlugins({
        roots: [
          root,
        ],
        dataDir,
        connectTimeoutMs: 3000,
      });
      const { ctx } = fakeExecutionContext();
      await layer.hooks.init?.({
        storage: makeScopedStorage(),
        scopeKey: 'thread:test',
        ctx,
      });
      await layer.hooks.dispose?.({
        state: {
          activated: [],
        },
      });

      // The declared transport was attempted, and no fallback followed it.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toBe('POST /mcp');
    } finally {
      server.stop(true);
    }
  }, 20_000);
});

//#endregion

//#region Live MCP round trip

/**
 * A stdio MCP server written against the wire protocol directly rather than
 * the SDK, so it needs no `node_modules` inside the temp fixture. The stdio
 * transport is newline-delimited JSON-RPC, which is small enough to speak by
 * hand.
 *
 * It echoes back the `PLUGIN_ROOT` and `PLUGIN_DATA` it was launched with,
 * which is what turns this into an end-to-end check of §9.1 rather than just
 * a check that a connection can be made.
 */
const FIXTURE_SERVER = `
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const TOOL = {
  name: 'echo_env',
  description: 'Returns the plugin variables this server was launched with.',
  inputSchema: { type: 'object', properties: { prefix: { type: 'string' } } },
};
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture-server', version: '1.0.0' },
        },
      });
      continue;
    }
    if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [TOOL] } });
      continue;
    }
    if (msg.method === 'tools/call') {
      const prefix = (msg.params.arguments && msg.params.arguments.prefix) || '';
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [
            {
              type: 'text',
              text: prefix + JSON.stringify({
                pluginRoot: process.env.PLUGIN_ROOT,
                pluginData: process.env.PLUGIN_DATA,
                cwd: process.cwd(),
                config: process.env.CONFIG,
              }),
            },
          ],
        },
      });
      continue;
    }
    if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});
`;

describe('live stdio MCP server', () => {
  test('connects, lists tools, and round-trips a call with the §9.1 environment', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('toolbox'),
        files: {
          'bin/server.mjs': FIXTURE_SERVER,
        },
        mcp: mcpConfig({
          fixture: {
            type: 'stdio',
            command: 'node',
            args: [
              `${ROOT_VAR}/bin/server.mjs`,
            ],
            env: {
              CONFIG: `${ROOT_VAR}/config.json`,
            },
            cwd: DATA_VAR,
          },
        }),
      },
    ]);
    await chmod(join(root, 'toolbox', 'bin', 'server.mjs'), 0o755);

    const layer = agentPlugins({
      roots: [
        root,
      ],
      dataDir,
    });
    const { ctx } = fakeExecutionContext();
    await layer.hooks.init?.({
      storage: makeScopedStorage(),
      scopeKey: 'thread:test',
      ctx,
    });

    try {
      const tools = layer.readMcpTools();
      expect(layer.readDiagnostics()).toEqual([]);
      expect(tools.map((t) => t.qualifiedName)).toEqual([
        'toolbox/fixture/echo_env',
      ]);

      const decl = layer.provides?.callMcpTool;
      expect(decl?.kind).toBe('function');
      if (decl === undefined || decl.kind !== 'function') {
        return;
      }
      const outcome = await decl.execute(
        {
          server: 'toolbox/fixture',
          tool: 'echo_env',
          arguments: {
            prefix: 'ENV=',
          },
        },
        {
          activated: [],
        },
        ctx,
      );

      const payload = JSON.stringify(outcome.result);
      expect(payload).toContain('ENV=');
      // §9.1: the client supplied both reserved variables to the subprocess…
      expect(payload).toContain(join(root, 'toolbox'));
      expect(payload).toContain(join(dataDir, 'toolbox'));
      // …§9.2: and expanded the placeholder in the configured env value.
      expect(payload).toContain(join(root, 'toolbox', 'config.json'));
    } finally {
      await layer.hooks.dispose?.({
        state: {
          activated: [],
        },
      });
    }
  }, 20_000);

  test('an unknown server key is reported to the model, not thrown', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
      },
    ]);
    const layer = agentPlugins({
      roots: [
        root,
      ],
      dataDir,
    });
    const { ctx } = fakeExecutionContext();
    await layer.hooks.init?.({
      storage: makeScopedStorage(),
      scopeKey: 'thread:test',
      ctx,
    });

    const decl = layer.provides?.callMcpTool;
    if (decl === undefined || decl.kind !== 'function') {
      throw new Error('callMcpTool should be exposed');
    }
    const outcome = await decl.execute(
      {
        server: 'nope/nope',
        tool: 'x',
      },
      {
        activated: [],
      },
      ctx,
    );
    expect(JSON.stringify(outcome.result)).toContain('no connected MCP server');
  });

  test('connectMcpServer reports a launch failure instead of throwing', async () => {
    const base = await tempDir();
    const pluginRoot = join(base, 'p');
    await mkdir(pluginRoot, {
      recursive: true,
    });

    const result = await connectMcpServer({
      server: {
        key: 'p/missing',
        type: McpTransport.Stdio,
        command: 'noetic-agent-plugins-no-such-executable',
        args: [],
        env: {},
        cwd: pluginRoot,
      },
      pluginRoot,
      pluginData: join(base, 'data'),
    });
    expect(result.ok).toBe(false);
  });
});

//#endregion
