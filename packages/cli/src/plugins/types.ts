import type { MemoryLayer, Tool } from '@noetic/core';

import type { SkillDefinition } from '../skills/types.js';
import type { AgentConfig } from '../types/config.js';

export interface NoeticPlugin {
  name: string;
  version: string;
  tools?: () => ReadonlyArray<Tool> | Promise<ReadonlyArray<Tool>>;
  memoryLayers?: () => ReadonlyArray<MemoryLayer> | Promise<ReadonlyArray<MemoryLayer>>;
  skills?: () => ReadonlyArray<SkillDefinition> | Promise<ReadonlyArray<SkillDefinition>>;
  initialize?: (config: AgentConfig) => Promise<void>;
  dispose?: () => Promise<void>;
}
