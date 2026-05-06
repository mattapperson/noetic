import type { FsAdapter, MemoryLayer, ShellAdapter, Step, StorageAdapter, Tool } from '@noetic/core';
import type { CallModel } from '../ai/plugin-call-model.js';
import type { LspServerContribution } from '../lsp/types.js';
import type { ReminderTrigger } from '../memory/reminder-triggers.js';
import type { SkillDefinition } from '../skills/types.js';
import type { AgentConfig } from '../types/config.js';

export interface SubagentArgs {
  /** Free-form natural-language prompt describing the task. */
  prompt: string;
  /** Working directory for read-only tool resolution. */
  cwd: string;
  /** Model identifier passed through to the underlying `step.llm`. */
  model: string;
  /** Optional unique id for the spawned step. Auto-generated when omitted. */
  id?: string;
  /** Optional fs adapter; defaults to local fs (via `createReadOnlyTools` defaults). */
  fs?: FsAdapter;
  /** Optional shell adapter; defaults to local shell. */
  shell?: ShellAdapter;
}

export type SubagentPreset = (args: SubagentArgs) => Step<unknown, string, string>;

/**
 * Capabilities an agent host injects into every SDK plugin hook. This context
 * intentionally excludes CLI/TUI concepts so the same plugin can run inside a
 * browser, Worker, isolate, service, or CLI host.
 */
export interface AgentPluginContext {
  /** The parsed agent config (model, apiKey, cwd, ...). */
  config: AgentConfig;
  /**
   * Call the configured LLM for one-shot generation. Plugins that need tool
   * loops should register tools and let the harness drive the turn.
   */
  callModel: CallModel;
  /** Returns plugin-scoped storage. Browser/Worker hosts may use memory storage. */
  pluginStorage: (scope: PluginStorageScope) => StorageAdapter;
}

export interface AgentPlugin {
  name: string;
  version: string;
  tools?: (ctx: AgentPluginContext) => ReadonlyArray<Tool> | Promise<ReadonlyArray<Tool>>;
  memoryLayers?: (
    ctx: AgentPluginContext,
  ) => ReadonlyArray<MemoryLayer> | Promise<ReadonlyArray<MemoryLayer>>;
  skills?: (
    ctx: AgentPluginContext,
  ) => ReadonlyArray<SkillDefinition> | Promise<ReadonlyArray<SkillDefinition>>;
  initialize?: (ctx: AgentPluginContext) => Promise<void>;
  dispose?: () => Promise<void>;
  subagentPresets?: () => Record<string, SubagentPreset> | Promise<Record<string, SubagentPreset>>;
  reminderTriggers?: (
    ctx: AgentPluginContext,
  ) => ReadonlyArray<ReminderTrigger> | Promise<ReadonlyArray<ReminderTrigger>>;
  /**
   * Optional language-server contributions. Runtime-specific launch strategies
   * must be implemented by the host as plugins/adapters and may no-op where
   * process spawning is unavailable.
   */
  lspServers?: (
    ctx: AgentPluginContext,
  ) => ReadonlyArray<LspServerContribution> | Promise<ReadonlyArray<LspServerContribution>>;
}

export type PluginContext = AgentPluginContext;
export type NoeticPlugin = AgentPlugin;
export type PluginStorageScope = 'project' | 'user';
