import { isAbsolute, resolve } from 'node:path';

import { z } from 'zod';

import type { AgentConfig, PluginSpec } from '../types/config.js';
import type { NoeticPlugin } from './types.js';

//#region Schema

const NoeticPluginSchema = z.object({
  name: z.string().min(1, 'Plugin name is required'),
  version: z.string().min(1, 'Plugin version is required'),
  tools: z.function().optional(),
  memoryLayers: z.function().optional(),
  initialize: z.function().optional(),
  dispose: z.function().optional(),
});

//#endregion

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

function isNoeticPlugin(value: unknown): value is NoeticPlugin {
  return NoeticPluginSchema.safeParse(value).success;
}

function validatePlugin(candidate: unknown, modulePath: string): NoeticPlugin {
  const result = NoeticPluginSchema.safeParse(candidate);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid plugin at ${modulePath}:\n${issues}`);
  }

  if (!isNoeticPlugin(candidate)) {
    throw new Error(`Invalid plugin at ${modulePath}: validation passed but type guard failed`);
  }

  return candidate;
}

function hasDefaultExport(module: object): module is object & {
  default: unknown;
} {
  return 'default' in module;
}

async function importPlugin(spec: PluginSpec, baseDir: string): Promise<NoeticPlugin> {
  const modulePath = resolvePluginPath(spec, baseDir);
  const module = await import(modulePath);

  const candidate = hasDefaultExport(module) ? module.default : module;

  return validatePlugin(candidate, modulePath);
}

//#endregion

//#region Public API

export async function loadPlugins(config: AgentConfig, baseDir: string): Promise<NoeticPlugin[]> {
  const plugins: NoeticPlugin[] = [];
  const initializedPlugins: NoeticPlugin[] = [];
  const seenNames = new Set<string>();

  for (const spec of config.plugins ?? []) {
    const plugin = await importPlugin(spec, baseDir);
    if (seenNames.has(plugin.name)) {
      await disposePlugins(initializedPlugins);
      throw new Error(`Duplicate plugin name: ${plugin.name}`);
    }
    seenNames.add(plugin.name);

    try {
      await plugin.initialize?.(config);
      initializedPlugins.push(plugin);
    } catch (error) {
      await disposePlugins(initializedPlugins);
      throw error;
    }

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
