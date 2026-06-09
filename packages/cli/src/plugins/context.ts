import { createCallModel } from '@noetic-tools/code-agent/plugins';
import type { AgentConfig } from '../types/config.js';
import { createDataDir, createNodePluginStorage } from './data-dir.js';
import type { PluginContext } from './types.js';

export type PluginContextBuilder = (pluginName: string) => PluginContext;

export function createPluginContextBuilder(config: AgentConfig): PluginContextBuilder {
  const callModel = createCallModel({
    apiKey: config.apiKey,
    defaultModel: config.model,
  });
  return (pluginName: string) => ({
    config,
    callModel,
    pluginStorage: (scope) => createNodePluginStorage(config.cwd, pluginName, scope),
    dataDir: createDataDir(config.cwd, pluginName),
  });
}

export type { PluginContext } from './types.js';
