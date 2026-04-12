import type { MemoryLayer, Tool } from '@noetic/core';
import { AgentHarness, step } from '@noetic/core';

import { buildSystemPrompt } from '../ai/system-prompt.js';
import { skillsLayer } from '../memory/skills-layer.js';
import type { NoeticPlugin } from '../plugins/types.js';
import { discoverSkills } from '../skills/discovery.js';
import type { SkillDefinition } from '../skills/types.js';
import { SkillSource } from '../skills/types.js';
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

async function collectPluginSkills(
  plugins: ReadonlyArray<NoeticPlugin>,
): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];
  for (const plugin of plugins) {
    const pluginSkills = await plugin.skills?.();
    if (!pluginSkills) {
      continue;
    }
    skills.push(
      ...pluginSkills.map((s) => ({
        ...s,
        source: SkillSource.Plugin,
        filePath: s.filePath ?? null,
      })),
    );
  }
  return skills;
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
): Promise<
  AgentHarness<{
    model: string;
  }>
> {
  // Discover skills from filesystem and plugins
  const filesystemSkills = await discoverSkills(config.cwd);
  const pluginSkills = await collectPluginSkills(plugins);

  // Merge skills (filesystem skills have priority, they're already deduplicated)
  const skillsByName = new Map<string, SkillDefinition>();
  for (const skill of [
    ...pluginSkills,
    ...filesystemSkills,
  ]) {
    skillsByName.set(skill.name, skill);
  }
  const allSkills = [
    ...skillsByName.values(),
  ];

  // Build tools including skill activation
  const builtinTools = createCodingTools(config.cwd);
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

  // Build memory layers including skills layer
  const pluginMemory = await collectPluginMemory(plugins);
  const memory: MemoryLayer[] = [
    ...pluginMemory,
    ...(allSkills.length > 0
      ? [
          skillsLayer(allSkills, {
            cwd: config.cwd,
          }),
        ]
      : []),
  ];

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
