/**
 * Minimal `@noetic/cli` shim for doc-snippet type-checking. The real cli source
 * pulls in Bun globals and other runtime-only deps that aren't available in the
 * snippet harness, so we expose just the public types referenced by documentation.
 */

import type { MemoryLayer, Tool } from '@noetic-tools/core';

export interface AgentConfig {
  model?: string;
  cwd?: string;
  apiKey?: string;
  maxTurns?: number;
  systemPrompt?: string;
  systemPromptMode?: 'compose' | 'replace';
  tools?: ReadonlyArray<Tool>;
  memoryLayers?: ReadonlyArray<MemoryLayer>;
  worktree?: {
    'worktree-path'?: string;
    branch?: string;
    'pre-start'?: string | Record<string, string>;
    'post-start'?: string | Record<string, string>;
    'post-merge'?: string | Record<string, string>;
    'pre-remove'?: string | Record<string, string>;
    'clone-files'?: string[];
    cleanup?: 'always' | 'if-clean' | 'never';
  };
  history?: {
    maxItems?: number;
  };
  plugins?: ReadonlyArray<unknown>;
  ui?: {
    doublePressWindowMs?: number;
  };
  trustProjectEmbeddedCommands?: boolean;
}

export interface PluginContext {
  config: AgentConfig;
  callModel: (request: { system?: string; user: string }) => Promise<string>;
  dataDir: (scope: 'project' | 'user') => string;
}

export interface NoeticPlugin {
  name: string;
  version: string;
  tools?: (ctx: PluginContext) => ReadonlyArray<Tool> | Promise<ReadonlyArray<Tool>>;
  memoryLayers?: (
    ctx: PluginContext,
  ) => ReadonlyArray<MemoryLayer> | Promise<ReadonlyArray<MemoryLayer>>;
  skills?: (ctx: PluginContext) => ReadonlyArray<unknown> | Promise<ReadonlyArray<unknown>>;
  commands?: (ctx: PluginContext) => ReadonlyArray<{
    name: string;
    description: string;
    execute: (input: string, session: unknown) => Promise<unknown> | unknown;
  }>;
  subagentPresets?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  reminderTriggers?: (
    ctx: PluginContext,
  ) => ReadonlyArray<unknown> | Promise<ReadonlyArray<unknown>>;
  lspServers?: (ctx: PluginContext) => ReadonlyArray<unknown> | Promise<ReadonlyArray<unknown>>;
  footer?: () => unknown;
  loadingMessages?: () => ReadonlyArray<string> | Promise<ReadonlyArray<string>>;
  initialize?: (ctx: PluginContext) => Promise<void>;
  dispose?: () => Promise<void>;
}

export interface FooterContext {
  model: string;
  status: string;
  lastLayerUsage: unknown;
  contextLimit: number;
}

export declare function useFooterContext(): FooterContext;
