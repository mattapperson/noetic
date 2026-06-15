import * as CodeAgentConfig from '@noetic-tools/code-agent/config';
import type { FsAdapter } from '@noetic-tools/core';
import { z } from 'zod';

export const AgentSdkConfigSchema = CodeAgentConfig.AgentConfigSchema;
export const AgentOverrideSchema = CodeAgentConfig.AgentOverrideSchema;
export const HistoryConfigSchema = CodeAgentConfig.HistoryConfigSchema;
export const PluginSpecSchema = CodeAgentConfig.PluginSpecSchema;
export const SetupConfigSchema = CodeAgentConfig.SetupConfigSchema;
export const ShellConfigSchema = CodeAgentConfig.ShellConfigSchema;
export const WorktreeConfigSchema = CodeAgentConfig.WorktreeConfigSchema;
export const WorktreeHookSchema = CodeAgentConfig.WorktreeHookSchema;

export type AgentOverride = z.infer<typeof AgentOverrideSchema>;
export type AgentSdkConfig = z.infer<typeof AgentSdkConfigSchema>;
export type AgentSdkRuntimeConfig = AgentSdkConfig & {
  fs: FsAdapter;
};
export type HistoryConfig = z.infer<typeof HistoryConfigSchema>;
export type PluginSpec = z.infer<typeof PluginSpecSchema>;
export type SetupConfig = z.infer<typeof SetupConfigSchema>;
export type ShellConfig = z.infer<typeof ShellConfigSchema>;
export type WorktreeConfig = z.infer<typeof WorktreeConfigSchema>;
export type WorktreeHook = z.infer<typeof WorktreeHookSchema>;

/**
 * CLI/TUI-only tuning. Agent SDK hosts should not depend on this namespace.
 */
export const UiConfigSchema = z.object({
  doublePressWindowMs: z.number().int().min(100).max(5000).optional(),
  /**
   * Context Split View panel width. `'responsive'` (default) lets the layout
   * choose a column count based on terminal width; a number pins the panel
   * to that count. See specs/28-context-split-view.md.
   */
  contextPanelWidth: z
    .union([
      z.literal('responsive'),
      z.number().int().min(49).max(80),
    ])
    .optional(),
});

export type UiConfig = z.infer<typeof UiConfigSchema>;

export const AgentConfigSchema = AgentSdkConfigSchema.extend({
  ui: UiConfigSchema.optional(),
  agents: z.record(z.string(), AgentOverrideSchema).optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export interface AgentRuntimeConfig extends AgentConfig {
  fs: FsAdapter;
  /**
   * Post-setup-flow snapshot of which binaries are usable. Keys are binary
   * ids (`'rtk'`, `'pilotty'`, `'agent-browser'`); values are either
   * `'present'` (usable) or `'ignored'` (user opted out — the harness gates
   * or degrades the corresponding tool). Omit this map in non-CLI embedders
   * to keep defaults (every tool registered, rtk attempted then fallback).
   */
  binaryAvailability?: ReadonlyMap<string, 'present' | 'ignored'>;
}

/**
 * CLI-only flags carried alongside the serializable agent config.
 */
export interface CliFlags {
  continueLatest: boolean;
  resume: boolean | string;
  forkSession: boolean;
  sessionId?: string;
  modelExplicit: boolean;
  name?: string;
  noSessionPersistence: boolean;
}

export const DEFAULT_CLI_FLAGS: CliFlags = {
  continueLatest: false,
  resume: false,
  forkSession: false,
  modelExplicit: false,
  noSessionPersistence: false,
};
