import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { disposePlugins, loadPlugins } from '../src/plugins/loader.js';
import type { AgentConfig } from '../src/types/config.js';

const baseConfig: AgentConfig = {
  model: 'openai/gpt-4o-mini',
  cwd: process.cwd(),
  apiKey: 'test-key',
  maxTurns: 3,
};

describe('plugin loader', () => {
  it('loads a local plugin module from relative path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noetic-cli-plugin-'));
    const pluginPath = join(dir, 'test-plugin.ts');

    await writeFile(
      pluginPath,
      [
        'export default {',
        "  name: 'test-plugin',",
        "  version: '1.0.0'",
        '};',
      ].join('\n'),
      'utf8',
    );

    const plugins = await loadPlugins(
      {
        ...baseConfig,
        plugins: [
          './test-plugin.ts',
        ],
      },
      dir,
    );

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.name).toBe('test-plugin');
  });

  it('throws on duplicate plugin names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noetic-cli-plugin-'));
    await writeFile(
      join(dir, 'a.ts'),
      "export default { name: 'dup-plugin', version: '1.0.0' };",
      'utf8',
    );
    await writeFile(
      join(dir, 'b.ts'),
      "export default { name: 'dup-plugin', version: '1.0.0' };",
      'utf8',
    );

    await expect(
      loadPlugins(
        {
          ...baseConfig,
          plugins: [
            './a.ts',
            './b.ts',
          ],
        },
        dir,
      ),
    ).rejects.toThrow('Duplicate plugin name');
  });

  it('accepts plugins that provide footer and loadingMessages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noetic-cli-plugin-'));
    await writeFile(
      join(dir, 'with-ui.ts'),
      [
        'export default {',
        "  name: 'with-ui',",
        "  version: '1.0.0',",
        '  footer: () => null,',
        '  loadingMessages: () => [',
        "    'Pondering',",
        "    'Musing',",
        '  ],',
        '};',
      ].join('\n'),
      'utf8',
    );

    const plugins = await loadPlugins(
      {
        ...baseConfig,
        plugins: [
          './with-ui.ts',
        ],
      },
      dir,
    );

    expect(plugins[0]?.name).toBe('with-ui');
    expect(typeof plugins[0]?.footer).toBe('function');
    expect(typeof plugins[0]?.loadingMessages).toBe('function');
  });

  it('rejects plugins where footer is not a function', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noetic-cli-plugin-'));
    await writeFile(
      join(dir, 'bad-footer.ts'),
      [
        'export default {',
        "  name: 'bad-footer',",
        "  version: '1.0.0',",
        "  footer: 'not a function',",
        '};',
      ].join('\n'),
      'utf8',
    );

    await expect(
      loadPlugins(
        {
          ...baseConfig,
          plugins: [
            './bad-footer.ts',
          ],
        },
        dir,
      ),
    ).rejects.toThrow('Invalid plugin');
  });

  it('accepts already-instantiated plugins inline in config.plugins', async () => {
    const initCalls: string[] = [];
    const plugins = await loadPlugins(
      {
        ...baseConfig,
        plugins: [
          {
            name: 'inline-plugin',
            version: '1.2.3',
            initialize: async () => {
              initCalls.push('inline-plugin');
            },
            loadingMessages: () => [
              'Thinking',
            ],
          },
        ],
      },
      process.cwd(),
    );

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.name).toBe('inline-plugin');
    expect(typeof plugins[0]?.loadingMessages).toBe('function');
    expect(initCalls).toEqual([
      'inline-plugin',
    ]);
  });

  it('disposes plugins in reverse order', async () => {
    const calls: string[] = [];
    await disposePlugins([
      {
        name: 'first',
        version: '1.0.0',
        dispose: async () => {
          calls.push('first');
        },
      },
      {
        name: 'second',
        version: '1.0.0',
        dispose: async () => {
          calls.push('second');
        },
      },
    ]);

    expect(calls).toEqual([
      'second',
      'first',
    ]);
  });
});
