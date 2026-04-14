import type { FsAdapter, MemoryLayer, ShellAdapter, Tool } from '@noetic/core';
import {
  AgentHarness,
  createLocalShellAdapter,
  durableTaskState,
  fileReference,
  observationalMemory,
  planMemory,
  step,
  toolMemoryLayer,
  workingMemory,
} from '@noetic/core';

import { buildSystemPrompt } from '../ai/system-prompt.js';
import { skillsLayer } from '../memory/skills-layer.js';
import type { NoeticPlugin } from '../plugins/types.js';
import { buildSkillCatalog } from '../skills/catalog.js';
import type { SkillDefinition } from '../skills/types.js';
import { createActivateSkillTool, createCodingTools } from '../tools/index.js';
import type { AgentConfig } from '../types/config.js';

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

export interface HarnessWithSkills {
  harness: AgentHarness<{
    model: string;
  }>;
  skills: ReadonlyArray<SkillDefinition>;
  memoryLayers: ReadonlyArray<MemoryLayer>;
}

interface CreateAgentHarnessOpts {
  config: AgentConfig;
  plugins: ReadonlyArray<NoeticPlugin>;
  fs: FsAdapter;
  shell?: ShellAdapter;
}

/**
 * Create the agent harness with all tools, memory layers, and skills.
 * Returns both the harness and the canonical skill catalog for UI use.
 */
export async function createAgentHarness(opts: CreateAgentHarnessOpts): Promise<HarnessWithSkills> {
  const { config, plugins, fs } = opts;
  const shell = opts.shell ?? createLocalShellAdapter();

  // Build canonical skill catalog (single source of truth)
  const allSkills = await buildSkillCatalog(config.cwd, plugins, fs);

  // Build tools including skill activation
  const builtinTools = createCodingTools(config.cwd, fs, shell);
  const pluginTools = await collectPluginTools(plugins);
  const activateSkill = allSkills.length > 0 ? createActivateSkillTool(allSkills) : null;

  const tools = filterTools(
    [
      ...builtinTools,
      ...pluginTools,
      ...(activateSkill
        ? [
            activateSkill,
          ]
        : []),
    ],
    config,
  );

  // Build memory layers including plan and skills layers
  const pluginMemory = await collectPluginMemory(plugins);
  const memory: MemoryLayer[] = [
    planMemory(),
    workingMemory(),
    observationalMemory(),
    fileReference(),
    durableTaskState(),
    ...toolMemoryLayer(tools),
    ...pluginMemory,
    ...(allSkills.length > 0
      ? [
          skillsLayer(allSkills, {
            cwd: config.cwd,
          }),
        ]
      : []),
  ];

  const harness = new AgentHarness({
    name: 'noetic-cli',
    fs,
    shell,
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

  return {
    harness,
    skills: allSkills,
    memoryLayers: memory,
  };
}

//#endregion
