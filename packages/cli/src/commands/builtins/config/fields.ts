import { BUILT_IN_SKILLS } from '../../../skills/built-in/index.js';
import type { SkillDefinition } from '../../../skills/types.js';
import type { ConfigFieldDefinition, ConfigFieldPath } from './types.js';
import { ConfigTab, FieldKind } from './types.js';

//#region Static Field Registry

const STATIC_CONFIG_FIELDS: ReadonlyArray<ConfigFieldDefinition> = [
  {
    path: 'model',
    label: 'Model',
    kind: FieldKind.Text,
    tab: ConfigTab.Model,
    placeholder: 'anthropic/claude-sonnet-4',
    description: 'OpenRouter model identifier',
  },
  {
    path: 'apiKey',
    label: 'API Key',
    kind: FieldKind.MaskedText,
    tab: ConfigTab.Model,
    placeholder: 'OpenRouter API key',
    description: 'Stored in the config file when saved',
  },
  {
    path: 'maxTurns',
    label: 'Max Turns',
    kind: FieldKind.Number,
    tab: ConfigTab.Model,
    placeholder: '50',
    description: 'Positive integer turn limit',
  },
  {
    path: 'systemPromptMode',
    label: 'System Prompt Mode',
    kind: FieldKind.Select,
    tab: ConfigTab.Model,
    options: [
      'compose',
      'replace',
    ],
    description: 'How custom instructions combine with the built-in prompt',
  },
  {
    path: 'systemPrompt',
    label: 'System Prompt',
    kind: FieldKind.Multiline,
    tab: ConfigTab.Model,
    placeholder: 'Custom instructions...',
    description: 'Use \\n in edit mode for line breaks',
  },
  {
    path: 'cwd',
    label: 'Working Directory',
    kind: FieldKind.Text,
    tab: ConfigTab.Runtime,
    placeholder: '/path/to/project',
    description: 'Base directory where the agent operates',
  },
  {
    path: 'trustProjectEmbeddedCommands',
    label: 'Project Commands',
    kind: FieldKind.Boolean,
    tab: ConfigTab.Runtime,
    description: 'Allow project AGENT.md files to execute !commands at startup',
  },
  {
    path: 'worktree.enabled',
    label: 'Enable Worktree',
    kind: FieldKind.Boolean,
    tab: ConfigTab.Worktree,
    description: 'Enable git worktree isolation defaults',
  },
  {
    path: 'worktree.worktree-path',
    label: 'Worktree Path',
    kind: FieldKind.Text,
    tab: ConfigTab.Worktree,
    placeholder: '{{ repo_path }}/.worktrees/{{ worktree_name | sanitize }}',
    description: 'Template for worktree directory paths',
  },
  {
    path: 'worktree.branch',
    label: 'Branch Name',
    kind: FieldKind.Text,
    tab: ConfigTab.Worktree,
    placeholder: '{{ agent_id | sanitize }}',
    description: 'Template for worktree branch names',
  },
  {
    path: 'worktree.cleanup',
    label: 'Cleanup Policy',
    kind: FieldKind.Select,
    tab: ConfigTab.Worktree,
    options: [
      'always',
      'if-clean',
      'never',
    ],
    description: 'When to automatically clean up worktrees',
  },
  {
    path: 'worktree.clone-files',
    label: 'Clone Files',
    kind: FieldKind.List,
    tab: ConfigTab.Worktree,
    placeholder: '.env*, config/.env*',
    description: 'Comma-separated file patterns copied into new worktrees',
  },
  {
    path: 'tools.include',
    label: 'Included Tools',
    kind: FieldKind.List,
    tab: ConfigTab.Tools,
    description: 'Comma-separated allow-list; empty means include all tools',
  },
  {
    path: 'tools.exclude',
    label: 'Excluded Tools',
    kind: FieldKind.List,
    tab: ConfigTab.Tools,
    description: 'Comma-separated blocked tools',
  },
  {
    path: 'memory',
    label: 'Memory Layers',
    kind: FieldKind.List,
    tab: ConfigTab.Memory,
    description: 'Comma-separated ordered memory layer names',
  },
  {
    path: 'history.maxItems',
    label: 'History Window (items)',
    kind: FieldKind.Number,
    tab: ConfigTab.Memory,
    placeholder: '40',
    description:
      'Cap on items projected to the LLM. Storage is unaffected. Leave blank to disable.',
  },
];

//#endregion

//#region Dynamic Sub-agent Field Registry

/**
 * Build the agents-tab field set from the registered built-in agents
 * (`BUILT_IN_SKILLS` filtered to those with `agentType` set). For each
 * agent type we emit three fields: model, instructions, tools.
 *
 * The list is built once at module init — built-in skills are static text
 * imports, so the catalog never changes at runtime. User-defined agent
 * skills are not surfaced here yet (they can still be configured via the
 * `agents` field in `noetic.config.ts` directly).
 */
function buildAgentFields(skills: ReadonlyArray<SkillDefinition>): ConfigFieldDefinition[] {
  const fields: ConfigFieldDefinition[] = [];
  for (const skill of skills) {
    const agentType = skill.agentType;
    if (agentType === undefined || agentType.length === 0) {
      continue;
    }
    const skillModel = skill.agentModel;
    const placeholderModel =
      skillModel && skillModel !== 'inherit' ? skillModel : 'inherit from main agent';
    fields.push({
      path: `agents.${agentType}.model`,
      label: `${agentType} model`,
      kind: FieldKind.Text,
      tab: ConfigTab.Agents,
      placeholder: placeholderModel,
      description: `Model id for the ${agentType} sub-agent. Empty = inherit from SKILL.md.`,
    });
    fields.push({
      path: `agents.${agentType}.instructions`,
      label: `${agentType} instructions`,
      kind: FieldKind.Multiline,
      tab: ConfigTab.Agents,
      placeholder: 'Extra instructions appended to SKILL.md…',
      description: `Extra instructions for the ${agentType} sub-agent (appended to its SKILL.md body). Use \\n for line breaks.`,
    });
    fields.push({
      path: `agents.${agentType}.tools`,
      label: `${agentType} tools`,
      kind: FieldKind.List,
      tab: ConfigTab.Agents,
      placeholder: 'inherit from SKILL.md',
      description: `Comma-separated tool allow-list for the ${agentType} sub-agent. Empty = inherit from SKILL.md.`,
    });
  }
  return fields;
}

const AGENT_CONFIG_FIELDS: ReadonlyArray<ConfigFieldDefinition> = buildAgentFields(BUILT_IN_SKILLS);

//#endregion

//#region Public API

export const CONFIG_FIELDS: ReadonlyArray<ConfigFieldDefinition> = [
  ...STATIC_CONFIG_FIELDS,
  ...AGENT_CONFIG_FIELDS,
];

const CONFIG_FIELDS_INDEX: Map<string, ConfigFieldDefinition> = new Map(
  CONFIG_FIELDS.map((field) => [
    field.path,
    field,
  ]),
);

/**
 * Look up a field definition by its path. Returns `undefined` for an unknown
 * path — callers should treat that as a programming error.
 */
export function getFieldByPath(path: ConfigFieldPath): ConfigFieldDefinition | undefined {
  return CONFIG_FIELDS_INDEX.get(path);
}

/**
 * Same as `getFieldByPath` but throws on miss. Use at sites that already
 * established the path is valid (e.g. derived from `state.focusedField`).
 */
export function requireFieldByPath(path: ConfigFieldPath): ConfigFieldDefinition {
  const field = CONFIG_FIELDS_INDEX.get(path);
  if (!field) {
    throw new Error(`Unknown config field path: ${path}`);
  }
  return field;
}

export function getFieldsForTab(tab: ConfigTab): ReadonlyArray<ConfigFieldDefinition> {
  return CONFIG_FIELDS.filter((field) => field.tab === tab);
}

export function getFirstFieldForTab(tab: ConfigTab): ConfigFieldPath {
  const field = getFieldsForTab(tab)[0];
  return field?.path ?? 'model';
}

export function getNextField(
  current: ConfigFieldPath,
  offset: number,
  isFieldVisible: (path: ConfigFieldPath) => boolean,
): ConfigFieldPath {
  const field = getFieldByPath(current);
  if (!field) {
    return current;
  }
  const fields = getFieldsForTab(field.tab).filter((candidate) => isFieldVisible(candidate.path));
  if (fields.length === 0) {
    return current;
  }
  const index = Math.max(
    0,
    fields.findIndex((candidate) => candidate.path === current),
  );
  const nextIndex = (index + fields.length + offset) % fields.length;
  return fields[nextIndex]?.path ?? current;
}

//#endregion
