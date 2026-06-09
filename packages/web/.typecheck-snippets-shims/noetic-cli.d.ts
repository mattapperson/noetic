/**
 * Minimal `@noetic-tools/cli` shim for doc-snippet type-checking. The real cli source
 * pulls in Bun globals and other runtime-only deps that aren't available in the
 * snippet harness, so we expose just the public types referenced by documentation.
 */

import type { LastLayerUsage, MemoryLayer, StorageAdapter, Tool } from '@noetic-tools/core';

export interface AgentOverride {
  model?: string;
  instructions?: string;
  instructionsMode?: 'append' | 'replace';
  tools?: string[];
}

export interface AgentConfig {
  model?: string;
  cwd?: string;
  apiKey?: string;
  maxTurns?: number;
  systemPrompt?: string;
  systemPromptMode?: 'compose' | 'replace';
  trustProjectEmbeddedCommands?: boolean;
  plugins?: ReadonlyArray<unknown>;
  tools?: {
    include?: string[];
    exclude?: string[];
    tasks?: boolean;
  };
  memory?: string[];
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
  shell?: {
    useRtk?: boolean;
  };
  setup?: {
    ignoredBinaries?: string[];
  };
  ui?: {
    doublePressWindowMs?: number;
  };
  agents?: Record<string, AgentOverride>;
}

export interface CallModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallModelInput {
  messages: ReadonlyArray<CallModelMessage>;
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
}

export interface CallModelResponse {
  text: string;
  modelId: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export type CallModel = (input: CallModelInput) => Promise<CallModelResponse>;

export interface PluginContext {
  config: AgentConfig;
  callModel: CallModel;
  pluginStorage: (scope: 'project' | 'user') => StorageAdapter;
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
  status: 'ready' | 'submitted' | 'streaming' | 'error';
  lastLayerUsage: LastLayerUsage | undefined;
  contextLimit: number;
}

export declare function useFooterContext(): FooterContext;
