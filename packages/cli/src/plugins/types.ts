import type { LastLayerUsage, MemoryLayer, Tool } from '@noetic/core';
import type { ReactNode } from 'react';

import type { SkillDefinition } from '../skills/types.js';
import type { AgentConfig } from '../types/config.js';

//#region Footer extension point

/**
 * Read-only snapshot of session state passed to plugin-contributed footer components.
 * Plugin footer components read this via the `useFooterContext()` hook so the public
 * plugin API stays stable as new fields are added.
 */
export interface FooterContext {
  model: string;
  cwd: string;
  status: 'ready' | 'submitted' | 'streaming' | 'error';
  lastLayerUsage: LastLayerUsage | undefined;
  contextLimit: number;
  threadId: string;
  sessionStartedAt: number;
  entryCount: number;
}

//#endregion

export interface NoeticPlugin {
  name: string;
  version: string;
  tools?: () => ReadonlyArray<Tool> | Promise<ReadonlyArray<Tool>>;
  memoryLayers?: () => ReadonlyArray<MemoryLayer> | Promise<ReadonlyArray<MemoryLayer>>;
  skills?: () => ReadonlyArray<SkillDefinition> | Promise<ReadonlyArray<SkillDefinition>>;
  initialize?: (config: AgentConfig) => Promise<void>;
  dispose?: () => Promise<void>;
  /**
   * Optional footer component rendered between the chat area and the prompt input.
   * Components should read live session state via `useFooterContext()` rather than
   * taking it as props. If multiple plugins provide a footer, the first one wins.
   */
  footer?: () => ReactNode;
  /**
   * Optional pool of loading-spinner messages. One is picked per turn to replace the
   * default verb. Called once after plugin init; no per-turn calls.
   */
  loadingMessages?: () => ReadonlyArray<string> | Promise<ReadonlyArray<string>>;
}
