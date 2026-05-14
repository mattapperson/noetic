/**
 * PluginContext factory. The CLI builds one of these per process and then
 * stamps out a per-plugin context (with plugin-scoped `dataDir`) on demand.
 */

import { createInMemoryStorage } from '@noetic-tools/core/portable';
import { createCallModel } from '../ai/plugin-call-model.js';
import type { AgentConfig } from '../types/config.js';
import type { PluginContext } from './types.js';

export type PluginContextBuilder = (pluginName: string) => PluginContext;

export function createPluginContextBuilder(config: AgentConfig): PluginContextBuilder {
  const callModel = createCallModel({
    apiKey: config.apiKey,
    defaultModel: config.model,
  });
  const stores = new Map<string, ReturnType<typeof createInMemoryStorage>>();
  return (pluginName: string) => ({
    config,
    callModel,
    pluginStorage(scope) {
      const key = `${pluginName}:${scope}`;
      let store = stores.get(key);
      if (!store) {
        store = createInMemoryStorage();
        stores.set(key, store);
      }
      return store;
    },
  });
}
