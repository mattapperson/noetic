/**
 * Shared YAML frontmatter parser for SKILL.md files.
 *
 * Used by both the filesystem discovery loader and the built-in skills loader.
 */

import yaml from 'yaml';
import type { SkillFrontmatter } from './types.js';

//#region Types

export interface ParsedSkillFile {
  frontmatter: SkillFrontmatter;
  body: string;
}

//#endregion

//#region Helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSkillFrontmatter(value: unknown): value is SkillFrontmatter {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.name === 'string';
}

//#endregion

//#region Public API

/**
 * Parse a SKILL.md file's YAML frontmatter and body.
 *
 * Returns an empty `name` if the frontmatter is missing or invalid; callers should
 * fall back to a derived name (e.g. the directory name) in that case.
 */
export function parseFrontmatter(content: string, filePath?: string): ParsedSkillFile {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
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
    return {
      frontmatter: {
        name: '',
      },
      body: fmMatch[2],
    };
  }

  return {
    frontmatter: parsed,
    body: fmMatch[2],
  };
}

//#endregion
