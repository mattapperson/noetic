import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

async function loadConfigModule(path: string): Promise<AgentConfig> {
  const module = await import(path);
  const exported = 'default' in module ? module.default : module;
  return AgentConfigSchema.parse(exported);
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
