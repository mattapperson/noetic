import type { FsAdapter } from '@noetic/core';
import {
  AgentConfigSchema as AgentSdkConfigSchema,
  type AgentConfig as AgentSdkConfig,
  type AgentOverride,
  AgentOverrideSchema,
  type AgentRuntimeConfig as AgentSdkRuntimeConfig,
  type HistoryConfig,
  HistoryConfigSchema,
  type PluginSpec,
  PluginSpecSchema,
  type ShellConfig,
  ShellConfigSchema,
  type WorktreeConfig,
  WorktreeConfigSchema,
  type WorktreeHook,
  WorktreeHookSchema,
} from '@noetic/code-agent/config';
import { z } from 'zod';

export {
  AgentOverrideSchema,
  AgentSdkConfigSchema,
  HistoryConfigSchema,
  PluginSpecSchema,
  ShellConfigSchema,
  WorktreeConfigSchema,
  WorktreeHookSchema,
};
export type {
  AgentOverride,
  AgentSdkConfig,
  AgentSdkRuntimeConfig,
  HistoryConfig,
  PluginSpec,
  ShellConfig,
  WorktreeConfig,
  WorktreeHook,
};

/**
 * CLI/TUI-only tuning. Agent SDK hosts should not depend on this namespace.
 */
export const UiConfigSchema = z.object({
  doublePressWindowMs: z.number().int().min(100).max(5000).optional(),
});

export type UiConfig = z.infer<typeof UiConfigSchema>;

export const AgentConfigSchema = AgentSdkConfigSchema.extend({
  ui: UiConfigSchema.optional(),
  agents: z.record(z.string(), AgentOverrideSchema).optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export interface AgentRuntimeConfig extends AgentConfig {
  fs: FsAdapter;
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
