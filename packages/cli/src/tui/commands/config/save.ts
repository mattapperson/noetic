import { join } from 'node:path';

import type { AgentConfig } from '../../../types/config.js';
import { serializeConfig } from './serialization.js';
import type { ConfigFieldPath } from './types.js';

//#region Types

export interface SaveConfigInput {
  config: AgentConfig;
  editedFields: ReadonlySet<ConfigFieldPath>;
  sourcePath?: string;
}

export interface SaveConfigResult {
  sourcePath: string;
}

//#endregion

//#region Public API

export async function saveConfig(input: SaveConfigInput): Promise<SaveConfigResult> {
  const sourcePath = input.sourcePath ?? join(process.cwd(), 'noetic.config.ts');
  const content = serializeConfig(input.config, input.editedFields);
  await Bun.write(sourcePath, content);
  return {
    sourcePath,
  };
}

//#endregion
