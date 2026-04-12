import { AgentHarness, step } from '@noetic/core';
import type { MemoryLayer, Tool } from '@noetic/core';

import { buildSystemPrompt } from '../ai/system-prompt.js';
import { createCodingTools } from '../tools/index.js';
import type { AgentConfig } from '../types/config.js';
import type { NoeticPlugin } from '../plugins/types.js';

//#region Helpers

async function collectPluginTools(plugins: ReadonlyArray<NoeticPlugin>): Promise<Tool[]> {
  const tools: Tool[] = [];
  for (const plugin of plugins) {
    const pluginTools = await plugin.tools?.();
    if (!pluginTools) {
      continue;
    }
    tools.push(...pluginTools);
  }
  return tools;
}

async function collectPluginMemory(plugins: ReadonlyArray<NoeticPlugin>): Promise<MemoryLayer[]> {
  const layers: MemoryLayer[] = [];
  for (const plugin of plugins) {
    const memoryLayers = await plugin.memoryLayers?.();
    if (!memoryLayers) {
      continue;
    }
    layers.push(...memoryLayers);
  }
  return layers;
}

function filterTools(allTools: Tool[], config: AgentConfig): Tool[] {
  const includes = new Set(config.tools?.include ?? []);
  const excludes = new Set(config.tools?.exclude ?? []);

  return allTools.filter((tool) => {
    if (includes.size > 0 && !includes.has(tool.name)) {
      return false;
    }
    if (excludes.has(tool.name)) {
      return false;
    }
    return true;
  });
}

//#endregion

//#region Public API

export async function createAgentHarness(
  config: AgentConfig,
  plugins: ReadonlyArray<NoeticPlugin>,
): Promise<AgentHarness<{ model: string }>> {
  const builtinTools = createCodingTools(config.cwd);
  const pluginTools = await collectPluginTools(plugins);
  const tools = filterTools(
    [
      ...builtinTools,
      ...pluginTools,
    ],
    config,
  );
  const memory = await collectPluginMemory(plugins);

  return new AgentHarness({
    name: 'noetic-cli',
    params: {
      model: config.model,
    },
    initialStep: step.llm({
      id: 'chat',
      model: config.model,
      instructions: config.systemPrompt ?? buildSystemPrompt(config.cwd),
      tools,
    }),
    memory,
    llm: {
      provider: 'openrouter',
      apiKey: config.apiKey,
    },
  });
}

//#endregion
