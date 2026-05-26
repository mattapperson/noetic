import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { safePluginNameSegment } from '@noetic/code-agent/utils';
import { createDataDir } from '../src/plugins/data-dir.js';

describe('safePluginNameSegment', () => {
  it('strips scope prefix', () => {
    expect(safePluginNameSegment('@noetic/plugin-powerline')).toBe('plugin-powerline');
  });

  it('leaves un-scoped names alone', () => {
    expect(safePluginNameSegment('plain-plugin')).toBe('plain-plugin');
  });

  it('sanitises spaces and slashes to dashes', () => {
    expect(safePluginNameSegment('weird/one/with spaces')).toBe('weird-one-with-spaces');
  });

  it('strips scope prefix then sanitises rest', () => {
    expect(safePluginNameSegment('@scope/plugin/sub')).toBe('plugin-sub');
  });
});

describe('createDataDir', () => {
  it('creates a project-scoped dir under cwd/.noetic/<name>', () => {
    const base = mkdtempSync(join(tmpdir(), 'noetic-dd-'));
    const dataDir = createDataDir(base, 'plugin-foo');
    const projectDir = dataDir('project');
    expect(projectDir).toBe(join(base, '.noetic', 'plugin-foo'));
    expect(existsSync(projectDir)).toBe(true);
  });

  it('rejects names with path separators', () => {
    expect(() => createDataDir('/tmp', '../evil')).toThrow(/Invalid plugin name/);
  });
});
