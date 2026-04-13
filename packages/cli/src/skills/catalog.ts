/**
 * Shared skill catalog builder.
 *
 * Provides a single source of truth for discovered skills,
 * used by both the harness and the UI.
 */

import type { FsAdapter } from '@noetic/core';
import type { NoeticPlugin } from '../plugins/types.js';

import { discoverSkills } from './discovery.js';
import type { SkillDefinition } from './types.js';
import { SkillSource } from './types.js';

//#region Plugin Skills

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

//#endregion

//#region Public API

/**
 * Build the canonical skill catalog from filesystem and plugins.
 *
 * This is the single source of truth for skill discovery.
 * Filesystem skills have priority over plugin skills with the same name.
 */
export async function buildSkillCatalog(
  cwd: string,
  plugins: ReadonlyArray<NoeticPlugin>,
  fs: FsAdapter,
): Promise<SkillDefinition[]> {
  const filesystemSkills = await discoverSkills(cwd, fs);
  const pluginSkills = await collectPluginSkills(plugins);

  // Merge skills (filesystem skills have priority, they're already deduplicated)
  const skillsByName = new Map<string, SkillDefinition>();
  for (const skill of [
    ...pluginSkills,
    ...filesystemSkills,
  ]) {
    skillsByName.set(skill.name, skill);
  }

  return [
    ...skillsByName.values(),
  ];
}

//#endregion
