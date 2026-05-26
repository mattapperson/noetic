import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

import type { AgentConfig, PluginSpec } from '../types/config.js';
import type { PluginContextBuilder } from './context.js';
import type { NoeticPlugin } from './types.js';

//#region Schemas

/**
 * Zod schema for validating plugin shape at runtime.
 * Uses z.unknown() for function fields since Zod's z.function() doesn't
 * preserve the specific function signatures from NoeticPlugin.
 */
const FN_FIELDS = [
  'tools',
  'memoryLayers',
  'skills',
  'initialize',
  'dispose',
  'footer',
  'loadingMessages',
  'commands',
  'subagentPresets',
  'reminderTriggers',
  'lspServers',
] as const;

const NoeticPluginSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    tools: z.unknown().optional(),
    memoryLayers: z.unknown().optional(),
    skills: z.unknown().optional(),
    initialize: z.unknown().optional(),
    dispose: z.unknown().optional(),
    footer: z.unknown().optional(),
    loadingMessages: z.unknown().optional(),
    commands: z.unknown().optional(),
    subagentPresets: z.unknown().optional(),
    reminderTriggers: z.unknown().optional(),
    lspServers: z.unknown().optional(),
  })
  .refine(
    (obj) => {
      for (const field of FN_FIELDS) {
        const value = obj[field];
        if (value !== undefined && typeof value !== 'function') {
          return false;
        }
      }
      return true;
    },
    {
      message: `Optional hook fields (${FN_FIELDS.join(', ')}) must be functions if provided`,
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

/**
 * An inline-plugin spec is a PluginSpec object that already has at least one
 * plugin hook defined. Distinguishing it from a `{name, path?, options?}`
 * spec lets `loadPlugins` use it directly instead of trying to `import()` it.
 */
function isInlineNoeticPlugin(spec: PluginSpec): spec is NoeticPlugin {
  if (typeof spec !== 'object' || spec === null) {
    return false;
  }
  if (!('version' in spec) || typeof spec.version !== 'string') {
    return false;
  }
  return isNoeticPlugin(spec);
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

  const path = typeof spec.path === 'string' ? spec.path : undefined;
  if (path) {
    if (isAbsolute(path)) {
      return path;
    }
    return resolve(baseDir, path);
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

export async function loadPlugins(
  config: AgentConfig,
  baseDir: string,
  buildContext?: PluginContextBuilder,
): Promise<NoeticPlugin[]> {
  const plugins: NoeticPlugin[] = [];
  const seenNames = new Set<string>();

  for (const spec of config.plugins ?? []) {
    const plugin = isInlineNoeticPlugin(spec) ? spec : await importPlugin(spec, baseDir);
    if (seenNames.has(plugin.name)) {
      throw new Error(`Duplicate plugin name: ${plugin.name}`);
    }
    seenNames.add(plugin.name);
    if (plugin.initialize) {
      if (!buildContext) {
        throw new Error(
          `Plugin ${plugin.name} defines initialize but loadPlugins was called without a context builder`,
        );
      }
      await plugin.initialize(buildContext(plugin.name));
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
