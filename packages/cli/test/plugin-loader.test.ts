import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPluginContextBuilder } from '../src/plugins/context.js';
import { disposePlugins, loadPlugins } from '../src/plugins/loader.js';
import type { NoeticPlugin } from '../src/plugins/types.js';
import type { AgentConfig } from '../src/types/config.js';

const baseConfig: AgentConfig = {
  model: 'openai/gpt-4o-mini',
  cwd: process.cwd(),
  apiKey: 'test-key',
  maxTurns: 3,
};

const buildCtx = createPluginContextBuilder(baseConfig);

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
      buildCtx,
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
        buildCtx,
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
      buildCtx,
    );

    expect(plugins[0]?.name).toBe('with-ui');
    expect(typeof plugins[0]?.footer).toBe('function');
    expect(typeof plugins[0]?.loadingMessages).toBe('function');
  });

  it('rejects plugins where reminderTriggers is not a function', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noetic-cli-plugin-'));
    await writeFile(
      join(dir, 'bad-reminder.ts'),
      [
        'export default {',
        "  name: 'bad-reminder',",
        "  version: '1.0.0',",
        "  reminderTriggers: 'not a function',",
        '};',
      ].join('\n'),
      'utf8',
    );

    await expect(
      loadPlugins(
        {
          ...baseConfig,
          plugins: [
            './bad-reminder.ts',
          ],
        },
        dir,
        buildCtx,
      ),
    ).rejects.toThrow('reminderTriggers');
  });

  it('rejects plugins where subagentPresets is not a function', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noetic-cli-plugin-'));
    await writeFile(
      join(dir, 'bad-presets.ts'),
      [
        'export default {',
        "  name: 'bad-presets',",
        "  version: '1.0.0',",
        '  subagentPresets: [],',
        '};',
      ].join('\n'),
      'utf8',
    );

    await expect(
      loadPlugins(
        {
          ...baseConfig,
          plugins: [
            './bad-presets.ts',
          ],
        },
        dir,
        buildCtx,
      ),
    ).rejects.toThrow('subagentPresets');
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
        buildCtx,
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
      buildCtx,
    );

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.name).toBe('inline-plugin');
    expect(typeof plugins[0]?.loadingMessages).toBe('function');
    expect(initCalls).toEqual([
      'inline-plugin',
    ]);
  });

  it('passes a PluginContext into initialize', async () => {
    let receivedCtx: unknown = null;
    const inspector: NoeticPlugin = {
      name: 'ctx-inspector',
      version: '1.0.0',
      initialize: async (ctx) => {
        receivedCtx = ctx;
      },
    };
    await loadPlugins(
      {
        ...baseConfig,
        plugins: [
          inspector,
        ],
      },
      process.cwd(),
      buildCtx,
    );
    expect(receivedCtx).not.toBeNull();
    if (
      receivedCtx !== null &&
      typeof receivedCtx === 'object' &&
      'config' in receivedCtx &&
      'callModel' in receivedCtx &&
      'dataDir' in receivedCtx
    ) {
      expect(typeof receivedCtx.callModel).toBe('function');
      expect(typeof receivedCtx.dataDir).toBe('function');
    } else {
      throw new Error('ctx missing expected shape');
    }
  });

  it('accepts plugins that provide commands', async () => {
    const plugins = await loadPlugins(
      {
        ...baseConfig,
        plugins: [
          {
            name: 'with-commands',
            version: '1.0.0',
            commands: () => [
              {
                name: 'my-cmd',
                description: 'test',
                type: 'local',
                load: async () => ({
                  call: async () => ({
                    type: 'skip',
                  }),
                }),
              },
            ],
          },
        ],
      },
      process.cwd(),
      buildCtx,
    );
    expect(typeof plugins[0]?.commands).toBe('function');
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
