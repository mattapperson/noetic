import type { MemoryLayer, Tool } from '@noetic/core';

import type { AgentConfig } from '../types/config.js';

export interface NoeticPlugin {
  name: string;
  version: string;
  tools?: () => ReadonlyArray<Tool> | Promise<ReadonlyArray<Tool>>;
  memoryLayers?: () => ReadonlyArray<MemoryLayer> | Promise<ReadonlyArray<MemoryLayer>>;
  initialize?: (config: AgentConfig) => Promise<void>;
  dispose?: () => Promise<void>;
}
