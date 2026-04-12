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
        plugins: ['./test-plugin.ts'],
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
          plugins: ['./a.ts', './b.ts'],
        },
        dir,
      ),
    ).rejects.toThrow('Duplicate plugin name');
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

    expect(calls).toEqual(['second', 'first']);
  });
});
