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
 *
 * A skill with `agentType` set is also a registerable sub-agent (teammate)
 * — its `instructions` become the child's system prompt and `allowedTools`
 * defines the child's tool pool. See `agents/` runtime registry.
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

  /**
   * Subagent type identifier. When set, this skill is registerable as a
   * teammate via the `agent` tool with `subagent_type: <agentType>`.
   */
  agentType?: string;

  /** Model override for the spawned teammate. `inherit` uses the parent's model. */
  agentModel?: 'inherit' | 'haiku' | 'sonnet' | 'opus' | string;

  /** Force the teammate to run in the background. */
  agentBackground?: boolean;

  /** Maximum reasoning steps for tool-bearing teammates (passed to `react`). */
  agentMaxSteps?: number;

  /** Skip injecting CLAUDE.md into the teammate's context (saves tokens for read-only agents). */
  agentOmitClaudeMd?: boolean;

  /** Allow this teammate to see the `agent` tool and spawn nested teammates. */
  agentCanSpawn?: boolean;
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
 *
 * Optional `agent-*` fields include `null` because YAML produces `null` for
 * empty values like `agent-type:` (no value). Consumers should normalize via
 * `mapFrontmatterToAgentFields` (which collapses null → undefined) rather
 * than reading these fields directly.
 */
interface SkillFrontmatter {
  name: string;
  // YAML produces `null` for empty values (e.g. `description:` with no value).
  // All optional fields accept null + undefined; consumers normalize via the
  // `nullToUndefined` helper in `frontmatter.ts`.
  description?: string | null;
  'when-to-use'?: string | null;
  'user-invocable'?: boolean | null;
  'model-invocable'?: boolean | null;
  'allowed-tools'?: string[] | null;
  'agent-type'?: string | null;
  'agent-model'?: 'inherit' | 'haiku' | 'sonnet' | 'opus' | string | null;
  'agent-background'?: boolean | null;
  'agent-max-steps'?: number | null;
  'agent-omit-claude-md'?: boolean | null;
  'agent-can-spawn'?: boolean | null;
}

//#endregion

export type { ProcessedInstructionEntry, SkillDefinition, SkillFrontmatter, SkillsLayerState };
export { SkillSource };
