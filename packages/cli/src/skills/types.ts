/**
 * Type definitions for the skills system.
 *
 * Skills are markdown files with YAML frontmatter that provide specialized
 * instructions to the agent when activated.
 */

//#region Source Type

const SkillSource = {
  Project: 'project',
  User: 'user',
  Plugin: 'plugin',
  BuiltIn: 'built-in',
} as const;

type SkillSource = (typeof SkillSource)[keyof typeof SkillSource];

//#endregion

//#region Skill Definition

/**
 * A discovered skill definition parsed from SKILL.md or provided by a plugin.
 */
interface SkillDefinition {
  /** Unique identifier (derived from directory name) */
  name: string;

  /** Brief description shown in context for model discovery */
  description: string;

  /** Guidance for when to use this skill */
  whenToUse?: string;

  /** Full markdown content after frontmatter (instructions) */
  instructions: string;

  /** Where the skill was loaded from */
  source: SkillSource;

  /** Absolute path to SKILL.md file (null for plugin-provided) */
  filePath: string | null;

  /** Can user invoke via /skill-name command */
  userInvocable: boolean;

  /** Can model invoke via activateSkill tool */
  modelInvocable: boolean;

  /** Optional tool restrictions when skill is active */
  allowedTools?: ReadonlyArray<string>;
}

//#endregion

//#region Skills Layer State

/**
 * Entry in the processed instructions cache with access timestamp for LRU eviction.
 */
interface ProcessedInstructionEntry {
  /** Processed instruction content */
  content: string;
  /** Timestamp of last access (for LRU eviction) */
  lastAccess: number;
}

/**
 * State managed by the skills memory layer.
 */
interface SkillsLayerState {
  /** All discovered skill definitions */
  definitions: SkillDefinition[];

  /** Names of currently activated skills */
  activatedSkills: string[];

  /** Cache of processed instructions (after inline command execution) with LRU metadata */
  processedInstructions: Map<string, ProcessedInstructionEntry>;
}

//#endregion

//#region Frontmatter Schema

/**
 * Expected shape of SKILL.md YAML frontmatter.
 */
interface SkillFrontmatter {
  name: string;
  description?: string;
  'when-to-use'?: string;
  'user-invocable'?: boolean;
  'model-invocable'?: boolean;
  'allowed-tools'?: string[];
}

//#endregion

export type { ProcessedInstructionEntry, SkillDefinition, SkillFrontmatter, SkillsLayerState };
export { SkillSource };
