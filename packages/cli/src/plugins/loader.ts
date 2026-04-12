import { isAbsolute, resolve } from 'node:path';

import type { AgentConfig, PluginSpec } from '../types/config.js';
import type { NoeticPlugin } from './types.js';

//#region Helpers

function resolvePluginPath(spec: PluginSpec, baseDir: string): string {
  if (typeof spec === 'string') {
    if (spec.startsWith('.') || spec.startsWith('/')) {
      return resolve(baseDir, spec);
    }
    return spec;
  }

  if (spec.path) {
    if (isAbsolute(spec.path)) {
      return spec.path;
    }
    return resolve(baseDir, spec.path);
  }

  return spec.name;
}

async function importPlugin(spec: PluginSpec, baseDir: string): Promise<NoeticPlugin> {
  const modulePath = resolvePluginPath(spec, baseDir);
  const module = await import(modulePath);
  const plugin = ('default' in module ? module.default : module) as NoeticPlugin;
  return plugin;
}

//#endregion

//#region Public API

export async function loadPlugins(config: AgentConfig, baseDir: string): Promise<NoeticPlugin[]> {
  const plugins: NoeticPlugin[] = [];
  const seenNames = new Set<string>();

  for (const spec of config.plugins ?? []) {
    const plugin = await importPlugin(spec, baseDir);
    if (seenNames.has(plugin.name)) {
      throw new Error(`Duplicate plugin name: ${plugin.name}`);
    }
    seenNames.add(plugin.name);
    await plugin.initialize?.(config);
    plugins.push(plugin);
  }

  return plugins;
}

export async function disposePlugins(plugins: ReadonlyArray<NoeticPlugin>): Promise<void> {
  for (const plugin of [
    ...plugins,
  ].reverse()) {
    await plugin.dispose?.();
  }
}

//#endregion
