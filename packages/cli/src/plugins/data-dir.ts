/**
 * Plugin-scoped data directory helper. Each plugin gets:
 *   - `project` scope → `<cwd>/.noetic/<plugin-name>/`
 *   - `user` scope    → `~/.noetic/<plugin-name>/`
 *
 * Created lazily on first access.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type DataDirScope = 'project' | 'user';

const PLUGIN_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function createDataDir(cwd: string, pluginName: string): (scope: DataDirScope) => string {
  if (!isSafePluginName(pluginName)) {
    throw new Error(`Invalid plugin name for data dir: ${pluginName}`);
  }
  return (scope) => {
    const base =
      scope === 'project'
        ? join(cwd, '.noetic', pluginName)
        : join(homedir(), '.noetic', pluginName);
    mkdirSync(base, {
      recursive: true,
    });
    return base;
  };
}

/**
 * Plugins can have slash-prefixed package names (e.g. `@noetic/plugin-foo`).
 * We normalise to a filesystem-safe segment by stripping the scope.
 */
export function pluginNameToDirSegment(pluginName: string): string {
  const bare = pluginName.startsWith('@') ? pluginName.split('/').slice(1).join('-') : pluginName;
  return bare.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function isSafePluginName(name: string): boolean {
  return PLUGIN_NAME_PATTERN.test(name);
}
