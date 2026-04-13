import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

import type { AgentConfig, PluginSpec } from '../types/config.js';
import type { NoeticPlugin } from './types.js';

//#region Schemas

/**
 * Zod schema for validating plugin shape at runtime.
 * Uses z.unknown() for function fields since Zod's z.function() doesn't
 * preserve the specific function signatures from NoeticPlugin.
 */
const NoeticPluginSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    tools: z.unknown().optional(),
    memoryLayers: z.unknown().optional(),
    initialize: z.unknown().optional(),
    dispose: z.unknown().optional(),
  })
  .refine(
    (obj) => {
      // Additional runtime checks for function fields
      if (obj.tools !== undefined && typeof obj.tools !== 'function') {
        return false;
      }
      if (obj.memoryLayers !== undefined && typeof obj.memoryLayers !== 'function') {
        return false;
      }
      if (obj.initialize !== undefined && typeof obj.initialize !== 'function') {
        return false;
      }
      if (obj.dispose !== undefined && typeof obj.dispose !== 'function') {
        return false;
      }
      return true;
    },
    {
      message:
        'Optional fields (tools, memoryLayers, initialize, dispose) must be functions if provided',
    },
  );

//#endregion

//#region Type Guards

/**
 * Type guard that validates and narrows unknown to NoeticPlugin.
 * Uses Zod for structural validation.
 */
function isNoeticPlugin(value: unknown): value is NoeticPlugin {
  return NoeticPluginSchema.safeParse(value).success;
}

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

function extractDefault(module: object): unknown {
  if ('default' in module) {
    return module.default;
  }
  return module;
}

async function importPlugin(spec: PluginSpec, baseDir: string): Promise<NoeticPlugin> {
  const modulePath = resolvePluginPath(spec, baseDir);
  const module = await import(modulePath);
  const candidate = extractDefault(module);
  if (!isNoeticPlugin(candidate)) {
    const parseResult = NoeticPluginSchema.safeParse(candidate);
    const errorMsg = parseResult.success ? 'Unknown validation error' : parseResult.error.message;
    throw new Error(`Invalid plugin at ${modulePath}: ${errorMsg}`);
  }
  return candidate;
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
