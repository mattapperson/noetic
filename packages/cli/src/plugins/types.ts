import type { AgentPlugin, AgentPluginContext } from '@noetic/code-agent/plugins';
import type { LastLayerUsage } from '@noetic/core';
import type { ReactNode } from 'react';
import type { Command } from '../commands/types.js';

export type PluginRenderable = ReactNode;

/**
 * Read-only snapshot of TUI session state passed to plugin footer components.
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
  agentMode: 'act' | 'planning';
}

export interface CliPluginContext extends AgentPluginContext {}

/**
 * CLI plugins are a strict superset of SDK agent plugins. Agent SDK hosts can
 * load CLI plugins and ignore CLI-only hooks; the hooks below are no-ops
 * outside the CLI/TUI host.
 */
export interface CliPlugin extends AgentPlugin {
  footer?: () => PluginRenderable;
  loadingMessages?: () => ReadonlyArray<string> | Promise<ReadonlyArray<string>>;
  commands?: (ctx: CliPluginContext) => ReadonlyArray<Command> | Promise<ReadonlyArray<Command>>;
}

export type PluginContext = CliPluginContext;
export type NoeticPlugin = CliPlugin;
export type AgentSdkPlugin = AgentPlugin;
