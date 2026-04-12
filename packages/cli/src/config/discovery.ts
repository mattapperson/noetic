import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ZodError } from 'zod';

import type { AgentConfig } from '../types/config.js';
import { AgentConfigSchema } from '../types/config.js';

//#region Types

export interface DiscoveredConfig {
  config: AgentConfig;
  sourcePath: string;
}

//#endregion

//#region Helpers

function configSearchPaths(): string[] {
  return [
    join(process.cwd(), 'noetic.config.ts'),
    join(process.cwd(), '.noetic', 'config.ts'),
    join(homedir(), '.config', 'noetic', 'config.ts'),
    join(homedir(), '.noetic', 'config.ts'),
  ];
}

function formatZodError(error: ZodError): string {
  return error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
}

function isModuleWithDefault(value: unknown): value is {
  default: unknown;
} {
  return typeof value === 'object' && value !== null && 'default' in value;
}

async function loadConfigModule(path: string): Promise<AgentConfig> {
  let module: unknown;
  try {
    module = await import(path);
  } catch (importError) {
    const message = importError instanceof Error ? importError.message : String(importError);
    throw new Error(`Failed to load config file "${path}":\n${message}`);
  }

  const exported = isModuleWithDefault(module) ? module.default : module;

  try {
    return AgentConfigSchema.parse(exported);
  } catch (parseError) {
    if (parseError instanceof ZodError) {
      throw new Error(`Invalid config in "${path}":\n${formatZodError(parseError)}`);
    }
    throw parseError;
  }
}

//#endregion

//#region Public API

export async function discoverConfig(): Promise<DiscoveredConfig | null> {
  for (const sourcePath of configSearchPaths()) {
    const file = Bun.file(sourcePath);
    if (!(await file.exists())) {
      continue;
    }

    const config = await loadConfigModule(sourcePath);
    return {
      config,
      sourcePath,
    };
  }

  return null;
}

export function resolvePluginBaseDir(sourcePath: string): string {
  return dirname(sourcePath);
}

//#endregion
