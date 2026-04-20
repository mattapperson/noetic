/**
 * PluginContext factory. The CLI builds one of these per process and then
 * stamps out a per-plugin context (with plugin-scoped `dataDir`) on demand.
 */

import { createCallModel } from '../ai/plugin-call-model.js';
import type { AgentConfig } from '../types/config.js';
import { createDataDir, pluginNameToDirSegment } from './data-dir.js';
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
    dataDir: createDataDir(config.cwd, pluginNameToDirSegment(pluginName)),
  });
}
