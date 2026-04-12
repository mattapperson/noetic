import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverConfig, resolvePluginBaseDir } from '../src/config/discovery.js';

const originalCwd = process.cwd();
const createdDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (!dir) {
      continue;
    }
    try {
      await rm(dir, {
        recursive: true,
        force: true,
      });
    } catch {
      // Directory may already be deleted or not exist
    }
  }
});

describe('config discovery', () => {
  it('loads noetic.config.ts from project root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noetic-cli-config-'));
    createdDirs.push(dir);
    await writeFile(
      join(dir, 'noetic.config.ts'),
      [
        'export default {',
        "  model: 'openai/gpt-4o-mini',",
        `  cwd: ${JSON.stringify(dir)},`,
        "  apiKey: 'test-key',",
        '  maxTurns: 3,',
        '};',
      ].join('\n'),
      'utf8',
    );

    process.chdir(dir);
    const discovered = await discoverConfig();

    expect(discovered).not.toBeNull();
    expect(discovered?.config.model).toBe('openai/gpt-4o-mini');
    expect(discovered?.sourcePath.endsWith(join(dir, 'noetic.config.ts'))).toBe(true);
  });

  it('resolves plugin base directory from config path', () => {
    const baseDir = resolvePluginBaseDir('/tmp/example/.noetic/config.ts');
    expect(baseDir).toBe('/tmp/example/.noetic');
  });
});
