/** Agent Plugins §6 (component discovery) and §11.3 (resilience). */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DiagnosticCode } from '../src/diagnostics';
import { discoverPlugins, loadPlugin } from '../src/discovery';
import { NOETIC_EXTENSION_NAMESPACE, PLUGIN_SCHEMA_ID } from '../src/manifest';
import {
  cleanupFixtures,
  linkFixture,
  makePluginRoot,
  manifest,
  mcpConfig,
  skillDoc,
  tempDir,
  writeFixture,
} from './_helpers';

afterAll(cleanupFixtures);

describe('§6.1 fixed locations', () => {
  test('discovers skills and MCP servers from a well-formed plugin', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('reports-plugin', {
          version: '1.2.0',
          description: 'Reporting helpers',
        }),
        skills: {
          summarize: skillDoc({
            name: 'summarize',
          }),
        },
        mcp: mcpConfig({
          api: {
            type: 'streamable-http',
            url: 'https://deploy.example.com/mcp',
          },
        }),
      },
    ]);

    const result = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(result.plugins).toHaveLength(1);
    const plugin = result.plugins[0];
    expect(plugin).toBeDefined();
    if (plugin === undefined) {
      return;
    }
    expect(plugin.manifest.name).toBe('reports-plugin');
    expect(plugin.skills.map((s) => s.qualifiedId)).toEqual([
      'reports-plugin/summarize',
    ]);
    expect(plugin.mcpServers.map((s) => s.qualifiedKey)).toEqual([
      'reports-plugin/api',
    ]);
    expect(plugin.dataDir).toBe(join(dataDir, 'reports-plugin'));
    expect(result.diagnostics).toHaveLength(0);
  });

  test('carries the SKILL.md body and frontmatter through', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
        skills: {
          deploy: skillDoc({
            name: 'deploy',
            description: 'Ships the app. Use when deploying.',
            body: '# Deploy\n\nRun the pipeline.',
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
    const skill = plugins[0]?.skills[0];
    expect(skill).toBeDefined();
    if (skill === undefined) {
      return;
    }
    expect(skill.frontmatter.description).toBe('Ships the app. Use when deploying.');
    expect(skill.body).toBe('# Deploy\n\nRun the pipeline.');
  });
});

describe('§6.2 missing and wrong-kind locations', () => {
  test('treats absent component locations as normal', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('bare'),
      },
    ]);
    const result = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(result.plugins).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(0);
  });

  test('invalidates only the skills type when `skills` is a regular file', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
        files: {
          skills: 'not a directory',
        },
        mcp: mcpConfig({
          api: {
            type: 'streamable-http',
            url: 'https://example.com/mcp',
          },
        }),
      },
    ]);

    const result = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    const plugin = result.plugins[0];
    expect(plugin).toBeDefined();
    if (plugin === undefined) {
      return;
    }
    expect(plugin.skills).toHaveLength(0);
    // MCP is unaffected.
    expect(plugin.mcpServers).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.ComponentTypeInvalid);
  });

  test('disables only MCP when `mcp.json` is a directory', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
        skills: {
          deploy: skillDoc({
            name: 'deploy',
          }),
        },
        files: {
          'mcp.json/placeholder': 'x',
        },
      },
    ]);

    const result = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    const plugin = result.plugins[0];
    expect(plugin).toBeDefined();
    if (plugin === undefined) {
      return;
    }
    expect(plugin.skills).toHaveLength(1);
    expect(plugin.mcpServers).toHaveLength(0);
    expect(result.diagnostics.some((d) => d.code === DiagnosticCode.McpDisabled)).toBe(true);
  });
});

describe('§7.1 skill discovery depth', () => {
  test('does not search deeper than the immediate children of skills/', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
        skills: {
          deploy: skillDoc({
            name: 'deploy',
          }),
        },
        files: {
          'skills/group/nested/SKILL.md': skillDoc({
            name: 'nested',
          }),
        },
      },
    ]);

    const result = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(result.plugins[0]?.skills.map((s) => s.id)).toEqual([
      'deploy',
    ]);
    // `group` is reported as skipped — it has no SKILL.md of its own.
    expect(
      result.diagnostics.some(
        (d) => d.code === DiagnosticCode.SkillSkipped && d.component === 'group',
      ),
    ).toBe(true);
  });

  test('skips a non-conforming skill and keeps its siblings', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
        skills: {
          good: skillDoc({
            name: 'good',
          }),
          // Frontmatter name does not match the directory.
          mismatched: skillDoc({
            name: 'something-else',
          }),
        },
      },
    ]);

    const result = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(result.plugins[0]?.skills.map((s) => s.id)).toEqual([
      'good',
    ]);
    const skipped = result.diagnostics.find((d) => d.code === DiagnosticCode.SkillSkipped);
    expect(skipped?.component).toBe('mismatched');
    expect(skipped?.detail).toContain('directory');
  });

  test('skips a skill whose SKILL.md is a symlink out of the plugin root', async () => {
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
      join(outside, 'EVIL.md'),
      skillDoc({
        name: 'sneaky',
      }),
      'utf8',
    );
    await mkdir(join(root, 'p', 'skills', 'sneaky'), {
      recursive: true,
    });
    await linkFixture(
      join(root, 'p', 'skills', 'sneaky', 'SKILL.md'),
      join(outside, 'EVIL.md'),
      'file',
    );

    const result = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(result.plugins[0]?.skills.map((s) => s.id)).toEqual([
      'good',
    ]);
    expect(
      result.diagnostics.some(
        (d) => d.code === DiagnosticCode.SkillSkipped && d.component === 'sneaky',
      ),
    ).toBe(true);
  });
});

describe('§11.3 fatal manifest problems', () => {
  test('rejects the whole plugin when plugin.json is not valid JSON', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        dir: 'broken',
        manifest: '{ not json',
        skills: {
          deploy: skillDoc({
            name: 'deploy',
          }),
        },
      },
    ]);

    const result = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(result.plugins).toHaveLength(0);
    expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.PluginRejected);
  });

  test('a rejected plugin does not stop a valid sibling from loading', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        dir: 'broken',
        manifest: JSON.stringify({
          $schema: PLUGIN_SCHEMA_ID,
          name: 'Not-Valid',
        }),
      },
      {
        manifest: manifest('good'),
        skills: {
          deploy: skillDoc({
            name: 'deploy',
          }),
        },
      },
    ]);

    const result = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(result.plugins.map((p) => p.manifest.name)).toEqual([
      'good',
    ]);
    expect(result.diagnostics.some((d) => d.code === DiagnosticCode.PluginRejected)).toBe(true);
  });

  test('rejects a directory with no plugin.json when loaded directly', async () => {
    const base = await tempDir();
    const dir = join(base, 'no-manifest');
    await mkdir(dir, {
      recursive: true,
    });
    const result = await loadPlugin(dir, join(base, 'data'));
    expect(result.plugin).toBeNull();
    expect(result.diagnostics[0]?.detail).toContain('§5.1');
  });
});

describe('scanning roots', () => {
  test('ignores directories without a plugin.json', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('real'),
      },
    ]);
    await mkdir(join(root, 'just-a-folder'), {
      recursive: true,
    });
    await writeFixture(join(root, 'just-a-folder', 'README.md'), 'not a plugin');

    const result = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(result.plugins.map((p) => p.manifest.name)).toEqual([
      'real',
    ]);
    expect(result.diagnostics).toHaveLength(0);
  });

  test('reports a root that does not exist instead of finding nothing quietly', async () => {
    // Silence here made the most likely configuration mistake undiagnosable:
    // the layer found no plugins and the agent simply told the user it had no
    // skills, with nothing anywhere explaining why.
    const base = await tempDir();
    const result = await discoverPlugins(
      [
        join(base, 'absent'),
      ],
      join(base, 'data'),
    );
    expect(result.plugins).toHaveLength(0);
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      DiagnosticCode.RootUnreadable,
    ]);
  });

  test('names the likely cause when roots points at a plugin instead of its parent', async () => {
    const { root } = await makePluginRoot([
      {
        manifest: manifest('p'),
      },
    ]);
    // One level too deep — the classic mistake.
    const result = await discoverPlugins(
      [
        join(root, 'p'),
      ],
      join(root, 'data'),
    );
    expect(result.plugins).toHaveLength(0);
    const empty = result.diagnostics.find((d) => d.code === DiagnosticCode.RootEmpty);
    expect(empty?.detail).toContain('looks like a plugin');
  });

  test('rejects the second plugin claiming an already-used name', async () => {
    const base = await tempDir();
    const dataDir = join(base, 'data');
    const rootA = join(base, 'a');
    const rootB = join(base, 'b');
    await writeFixture(join(rootA, 'dup', 'plugin.json'), manifest('dup'));
    await writeFixture(join(rootB, 'dup', 'plugin.json'), manifest('dup'));

    const result = await discoverPlugins(
      [
        rootA,
        rootB,
      ],
      dataDir,
    );
    expect(result.plugins).toHaveLength(1);
    const clash = result.diagnostics.find((d) => d.detail.includes('duplicate plugin name'));
    expect(clash).toBeDefined();
  });
});

describe('§8 client extensions', () => {
  test('surfaces the tools.noetic manifest data and directory', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p', {
          extensions: {
            [NOETIC_EXTENSION_NAMESPACE]: {
              layers: [
                './layers/custom.ts',
              ],
            },
            'com.other.client': {
              ignored: true,
            },
          },
        }),
        files: {
          [`${NOETIC_EXTENSION_NAMESPACE}/layers/custom.ts`]: 'export const x = 1;',
        },
      },
    ]);

    const { plugins } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    const plugin = plugins[0];
    expect(plugin).toBeDefined();
    if (plugin === undefined) {
      return;
    }
    expect(plugin.noeticExtension).toEqual({
      layers: [
        './layers/custom.ts',
      ],
    });
    expect(plugin.noeticExtensionDir).toBe(join(plugin.root, NOETIC_EXTENSION_NAMESPACE));
  });

  test('leaves the extension fields absent when the plugin ships neither', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
      },
    ]);
    const { plugins } = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    expect(plugins[0]?.noeticExtension).toBeUndefined();
    expect(plugins[0]?.noeticExtensionDir).toBeUndefined();
  });
});
