/**
 * Shared skill catalog builder.
 *
 * Provides a single source of truth for discovered skills,
 * used by both the harness and the UI.
 */

import type { FsAdapter } from '@noetic-tools/core';
import type { PluginContextBuilder } from '../plugins/context.js';
import type { NoeticPlugin } from '../plugins/types.js';

import { BUILT_IN_SKILLS } from './built-in/index.js';
import { discoverSkills } from './discovery.js';
import type { SkillDefinition } from './types.js';
import { SkillSource } from './types.js';

//#region Plugin Skills

async function collectPluginSkills(
  plugins: ReadonlyArray<NoeticPlugin>,
  buildCtx: PluginContextBuilder,
): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];
  for (const plugin of plugins) {
    const pluginSkills = await plugin.skills?.(buildCtx(plugin.name));
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

//#endregion

//#region Public API

/**
 * Build the canonical skill catalog from filesystem and plugins.
 *
 * This is the single source of truth for skill discovery.
 * Filesystem skills have priority over plugin skills with the same name.
 */
export interface BuildSkillCatalogArgs {
  cwd: string;
  plugins: ReadonlyArray<NoeticPlugin>;
  fs: FsAdapter;
  buildCtx: PluginContextBuilder;
}

export async function buildSkillCatalog(args: BuildSkillCatalogArgs): Promise<SkillDefinition[]> {
  const { cwd, plugins, fs, buildCtx } = args;
  const filesystemSkills = await discoverSkills(cwd, fs);
  const pluginSkills = await collectPluginSkills(plugins, buildCtx);

  // Precedence (later entries override earlier by name):
  // built-in (lowest) → plugin → filesystem (highest)
  const skillsByName = new Map<string, SkillDefinition>();
  for (const skill of [
    ...BUILT_IN_SKILLS,
    ...pluginSkills,
    ...filesystemSkills,
  ]) {
    skillsByName.set(skill.name, skill);
  }

  return [
    ...skillsByName.values(),
  ];
}

/**
 * Filter a catalog to skills that declare `agentType` (registerable as
 * teammates), deduplicated by `agentType` with last-wins precedence (matching
 * `getAgent`'s behavior). Two skills with different names but the same
 * agentType — e.g. a built-in being shadowed by a user-provided skill — yield
 * one entry per agentType.
 */
export function listAgents(catalog: ReadonlyArray<SkillDefinition>): SkillDefinition[] {
  const byAgentType = new Map<string, SkillDefinition>();
  for (const skill of catalog) {
    if (skill.agentType === undefined) {
      continue;
    }
    byAgentType.set(skill.agentType, skill);
  }
  return [
    ...byAgentType.values(),
  ];
}

/**
 * Look up a single agent definition by `agentType`. Last-wins on duplicates,
 * matching the precedence in `buildSkillCatalog`.
 */
export function getAgent(
  catalog: ReadonlyArray<SkillDefinition>,
  agentType: string,
): SkillDefinition | undefined {
  return catalog.findLast((s) => s.agentType === agentType);
}

//#endregion
