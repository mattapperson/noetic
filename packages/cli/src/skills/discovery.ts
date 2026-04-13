/**
 * Skill discovery module.
 *
 * Discovers skills from filesystem locations:
 * 1. ./.noetic/skills/{skill-name}/SKILL.md (project, highest priority)
 * 2. ./.agent/skills/{skill-name}/SKILL.md (project agent folder)
 * 3. ~/.noetic/skills/{skill-name}/SKILL.md (user noetic)
 * 4. ~/.agent/skills/{skill-name}/SKILL.md (user agent folder)
 */

import { homedir } from 'node:os';
import * as path from 'node:path';
import type { FsAdapter } from '@noetic/core';
import yaml from 'yaml';
import type { SkillDefinition, SkillFrontmatter } from './types.js';
import { SkillSource } from './types.js';

//#region Types

interface DiscoveredSkill extends SkillDefinition {
  priority: number;
}

interface ParsedSkillFile {
  frontmatter: SkillFrontmatter;
  body: string;
}

//#endregion

//#region Constants

/** Valid skill name pattern: alphanumeric, hyphens, underscores, starting with alphanumeric */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

//#endregion

//#region Helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name) && name.length <= 64;
}

function isSkillFrontmatter(value: unknown): value is SkillFrontmatter {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.name === 'string';
}

function parseFrontmatter(content: string, filePath?: string): ParsedSkillFile {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    // No frontmatter, treat entire content as body with derived name
    return {
      frontmatter: {
        name: '',
      },
      body: content,
    };
  }

  let parsed: unknown;
  try {
    parsed = yaml.parse(fmMatch[1]);
  } catch (err) {
    const location = filePath ? ` in ${filePath}` : '';
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[skills] Invalid YAML frontmatter${location}: ${message}`);
    return {
      frontmatter: {
        name: '',
      },
      body: fmMatch[2],
    };
  }

  if (!isSkillFrontmatter(parsed)) {
    const location = filePath ? ` in ${filePath}` : '';
    console.warn(
      `[skills] Frontmatter missing required 'name' field${location}, using directory name`,
    );
  }

  const frontmatter = isSkillFrontmatter(parsed)
    ? parsed
    : {
        name: '',
      };
  const body = fmMatch[2];

  return {
    frontmatter,
    body,
  };
}

interface LoadSkillFileParams {
  filePath: string;
  source: SkillSource;
  dirName: string;
  fs: FsAdapter;
}

async function loadSkillFile(params: LoadSkillFileParams): Promise<SkillDefinition> {
  const { filePath, source, dirName, fs } = params;
  const content = await fs.readFileText(filePath);
  const { frontmatter, body } = parseFrontmatter(content, filePath);

  const name = frontmatter.name || dirName;

  if (!isValidSkillName(name)) {
    throw new Error(
      `Invalid skill name '${name}': must be alphanumeric with hyphens/underscores, max 64 chars`,
    );
  }

  return {
    name,
    description: frontmatter.description ?? '',
    whenToUse: frontmatter['when-to-use'],
    instructions: body.trim(),
    source,
    filePath,
    userInvocable: frontmatter['user-invocable'] ?? true,
    modelInvocable: frontmatter['model-invocable'] ?? true,
    allowedTools: frontmatter['allowed-tools'],
  };
}

interface TryLoadSkillParams {
  dir: string;
  entry: string;
  source: SkillSource;
  fs: FsAdapter;
}

async function tryLoadSkill(params: TryLoadSkillParams): Promise<SkillDefinition | null> {
  const { dir, entry, source, fs } = params;
  const entryPath = path.join(dir, entry);
  try {
    const entryStat = await fs.stat(entryPath);
    if (!entryStat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    return await loadSkillFile({
      filePath: path.join(dir, entry, 'SKILL.md'),
      source,
      dirName: entry,
      fs,
    });
  } catch {
    return null;
  }
}

async function loadSkillsFromDirectory(
  dir: string,
  source: SkillSource,
  fs: FsAdapter,
): Promise<SkillDefinition[]> {
  try {
    const entries = await fs.readdir(dir);
    const results = await Promise.all(
      entries.map((entry) =>
        tryLoadSkill({
          dir,
          entry,
          source,
          fs,
        }),
      ),
    );
    return results.filter((s): s is SkillDefinition => s !== null);
  } catch {
    // Directory doesn't exist, return empty
    return [];
  }
}

//#endregion

//#region Public API

/**
 * Discover skills from all supported filesystem locations.
 *
 * Priority order (higher priority wins on name conflict):
 * 1. Project .noetic/skills/
 * 2. Project .agent/skills/
 * 3. User ~/.noetic/skills/
 * 4. User ~/.agent/skills/
 *
 * @param cwd - Current working directory (project root)
 * @param fs - Filesystem adapter
 * @returns Array of discovered skill definitions, deduplicated by name
 */
export async function discoverSkills(cwd: string, fs: FsAdapter): Promise<SkillDefinition[]> {
  const home = homedir();
  const discovered: DiscoveredSkill[] = [];

  // Define discovery locations with priorities
  const locations: Array<{
    dir: string;
    source: SkillSource;
    priority: number;
  }> = [
    {
      dir: path.join(cwd, '.noetic', 'skills'),
      source: SkillSource.Project,
      priority: 0,
    },
    {
      dir: path.join(cwd, '.agent', 'skills'),
      source: SkillSource.Project,
      priority: 1,
    },
    {
      dir: path.join(home, '.noetic', 'skills'),
      source: SkillSource.User,
      priority: 2,
    },
    {
      dir: path.join(home, '.agent', 'skills'),
      source: SkillSource.User,
      priority: 3,
    },
  ];

  const results = await Promise.all(
    locations.map(async ({ dir, source, priority }) => {
      const skills = await loadSkillsFromDirectory(dir, source, fs);
      return skills.map((s) => ({
        ...s,
        priority,
      }));
    }),
  );

  for (const skills of results) {
    discovered.push(...skills);
  }

  const byName = new Map<string, DiscoveredSkill>();
  for (const skill of discovered.sort((a, b) => a.priority - b.priority)) {
    if (!byName.has(skill.name)) {
      byName.set(skill.name, skill);
    }
  }

  return [
    ...byName.values(),
  ].map(({ priority: _, ...skill }) => skill);
}

/**
 * Load a single skill from a file path.
 * Useful for plugins providing skills from custom locations.
 */
export async function loadSkillFromFile(
  filePath: string,
  fs: FsAdapter,
  source: SkillSource = SkillSource.Plugin,
): Promise<SkillDefinition> {
  const dirName = path.basename(path.dirname(filePath));
  return loadSkillFile({
    filePath,
    source,
    dirName,
    fs,
  });
}

//#endregion
