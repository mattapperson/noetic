/**
 * Shared YAML frontmatter parser for SKILL.md files.
 *
 * Used by both the filesystem discovery loader and the built-in skills loader.
 * Validation goes through Zod so a malformed value (e.g. `description: 42`)
 * is caught explicitly rather than silently coerced.
 */

import yaml from 'yaml';
import { z } from 'zod';
import { warn } from '../util/log.js';
import type { SkillDefinition, SkillFrontmatter } from './types.js';

//#region Types

export interface ParsedSkillFile {
  frontmatter: SkillFrontmatter;
  body: string;
}

/** Subset of `SkillDefinition` carrying only the agent-related fields. */
type AgentFields = Pick<
  SkillDefinition,
  | 'agentType'
  | 'agentModel'
  | 'agentBackground'
  | 'agentMaxSteps'
  | 'agentOmitClaudeMd'
  | 'agentCanSpawn'
>;

//#endregion

//#region Schema

/**
 * Zod schema for a SKILL.md frontmatter block. YAML emits `null` for empty
 * values (e.g. `agent-type:` with no value), so optional fields accept
 * `null | undefined` and we collapse to `undefined` downstream.
 */
const SkillFrontmatterSchema = z.object({
  name: z.string(),
  description: z.string().nullish(),
  'when-to-use': z.string().nullish(),
  'user-invocable': z.boolean().nullish(),
  'model-invocable': z.boolean().nullish(),
  'allowed-tools': z.array(z.string()).nullish(),
  'agent-type': z.string().nullish(),
  'agent-model': z.string().nullish(),
  'agent-background': z.boolean().nullish(),
  'agent-max-steps': z.number().nullish(),
  'agent-omit-claude-md': z.boolean().nullish(),
  'agent-can-spawn': z.boolean().nullish(),
});

//#endregion

//#region Public API

/**
 * Parse a SKILL.md file's YAML frontmatter and body.
 *
 * Returns an empty `name` if the frontmatter is missing or invalid; callers
 * should fall back to a derived name (e.g. the directory name) in that case.
 * Specific failure modes (missing `---` block, invalid YAML, schema mismatch)
 * each emit a distinct warning via stderr so users see the actual problem.
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
    warn(`[skills] Invalid YAML frontmatter${location}: ${message}`);
    return {
      frontmatter: {
        name: '',
      },
      body: fmMatch[2],
    };
  }

  const result = SkillFrontmatterSchema.safeParse(parsed);
  if (!result.success) {
    const location = filePath ? ` in ${filePath}` : '';
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    warn(`[skills] Invalid frontmatter${location}: ${issues}`);
    return {
      frontmatter: {
        name: '',
      },
      body: fmMatch[2],
    };
  }

  return {
    frontmatter: result.data,
    body: fmMatch[2],
  };
}

/**
 * Map the agent-prefixed frontmatter fields onto the `SkillDefinition` shape.
 * Used by both the filesystem discovery loader and the built-in skills loader.
 *
 * `nullToUndefined` normalizes YAML's `null` (produced for empty values like
 * `agent-type:`) so downstream code sees `undefined`.
 */
export function mapFrontmatterToAgentFields(frontmatter: SkillFrontmatter): AgentFields {
  return {
    agentType: nullToUndefined(frontmatter['agent-type']),
    agentModel: nullToUndefined(frontmatter['agent-model']),
    agentBackground: nullToUndefined(frontmatter['agent-background']),
    agentMaxSteps: nullToUndefined(frontmatter['agent-max-steps']),
    agentOmitClaudeMd: nullToUndefined(frontmatter['agent-omit-claude-md']),
    agentCanSpawn: nullToUndefined(frontmatter['agent-can-spawn']),
  };
}

function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

//#endregion
