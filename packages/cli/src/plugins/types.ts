import type { LastLayerUsage, MemoryLayer, Tool } from '@noetic/core';
import type { ReactNode } from 'react';

import type { CallModel } from '../ai/plugin-call-model.js';
import type { Command } from '../commands/types.js';
import type { ReminderTrigger } from '../memory/reminder-triggers.js';
import type { SubagentPreset } from '../plan/subagents.js';
import type { SkillDefinition } from '../skills/types.js';
import type { AgentConfig } from '../types/config.js';
import type { DataDirScope } from './data-dir.js';

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
  /** Current agent mode: `'normal'` (full toolset) or `'planning'` (read-only, plan mode). */
  agentMode: 'normal' | 'planning';
}

//#endregion

//#region Plugin context

/**
 * Capabilities the host CLI injects into every plugin hook. Introducing new
 * fields on `PluginContext` is additive; existing plugins keep compiling.
 */
export interface PluginContext {
  /** The parsed agent config (model, apiKey, cwd, ...). */
  config: AgentConfig;
  /**
   * Call the configured LLM for one-shot generation (not tool loops). Uses
   * the same API key as the harness. Plugins that need tool loops should
   * register tools instead and let the harness drive the turn.
   */
  callModel: CallModel;
  /**
   * Returns a plugin-scoped data directory, creating it if needed.
   *  - 'project' → `<cwd>/.noetic/<plugin-name>/`
   *  - 'user'    → `~/.noetic/<plugin-name>/`
   */
  dataDir: (scope: DataDirScope) => string;
}

//#endregion

export interface NoeticPlugin {
  name: string;
  version: string;
  tools?: (ctx: PluginContext) => ReadonlyArray<Tool> | Promise<ReadonlyArray<Tool>>;
  memoryLayers?: (
    ctx: PluginContext,
  ) => ReadonlyArray<MemoryLayer> | Promise<ReadonlyArray<MemoryLayer>>;
  skills?: (
    ctx: PluginContext,
  ) => ReadonlyArray<SkillDefinition> | Promise<ReadonlyArray<SkillDefinition>>;
  /**
   * Called once after the plugin loads and before the TUI mounts. Receives
   * the plugin context so it can cache `callModel`, `dataDir`, etc. for later
   * use from hooks like `footer`, `commands`, `loadingMessages`.
   */
  initialize?: (ctx: PluginContext) => Promise<void>;
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
  /**
   * Optional slash commands contributed by this plugin. Merged into the CLI's
   * built-in commands with plugin commands appearing after built-ins (so a
   * plugin can't shadow `/help`, `/context`, etc.).
   */
  commands?: (ctx: PluginContext) => ReadonlyArray<Command> | Promise<ReadonlyArray<Command>>;
  /**
   * Optional registry of subagent presets the plugin contributes. These names
   * become valid `preset` values inside plan-mode flow JSON `subagent` nodes.
   */
  subagentPresets?: () => Record<string, SubagentPreset> | Promise<Record<string, SubagentPreset>>;
  /**
   * Optional reminder triggers contributed by this plugin. These are registered
   * alongside the built-in triggers on the reminder memory layer and can emit
   * `<system-reminder>`-wrapped developer messages based on state or cadence.
   */
  reminderTriggers?: (
    ctx: PluginContext,
  ) => ReadonlyArray<ReminderTrigger> | Promise<ReadonlyArray<ReminderTrigger>>;
}
