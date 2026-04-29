import type { ConfigFieldDefinition, ConfigFieldPath } from './types.js';
import { ConfigTab, FieldKind } from './types.js';

//#region Field Registry

export const CONFIG_FIELDS: ReadonlyArray<ConfigFieldDefinition> = [
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

const ModelField = CONFIG_FIELDS[0];
const ApiKeyField = CONFIG_FIELDS[1];
const MaxTurnsField = CONFIG_FIELDS[2];
const SystemPromptModeField = CONFIG_FIELDS[3];
const SystemPromptField = CONFIG_FIELDS[4];
const CwdField = CONFIG_FIELDS[5];
const TrustProjectEmbeddedCommandsField = CONFIG_FIELDS[6];
const WorktreeEnabledField = CONFIG_FIELDS[7];
const WorktreePathField = CONFIG_FIELDS[8];
const WorktreeBranchField = CONFIG_FIELDS[9];
const WorktreeCleanupField = CONFIG_FIELDS[10];
const WorktreeCloneFilesField = CONFIG_FIELDS[11];
const ToolsIncludeField = CONFIG_FIELDS[12];
const ToolsExcludeField = CONFIG_FIELDS[13];
const MemoryField = CONFIG_FIELDS[14];
const HistoryMaxItemsField = CONFIG_FIELDS[15];

export const CONFIG_FIELDS_BY_PATH: Record<ConfigFieldPath, ConfigFieldDefinition> = {
  model: ModelField,
  apiKey: ApiKeyField,
  maxTurns: MaxTurnsField,
  systemPromptMode: SystemPromptModeField,
  systemPrompt: SystemPromptField,
  cwd: CwdField,
  trustProjectEmbeddedCommands: TrustProjectEmbeddedCommandsField,
  'worktree.enabled': WorktreeEnabledField,
  'worktree.worktree-path': WorktreePathField,
  'worktree.branch': WorktreeBranchField,
  'worktree.cleanup': WorktreeCleanupField,
  'worktree.clone-files': WorktreeCloneFilesField,
  'tools.include': ToolsIncludeField,
  'tools.exclude': ToolsExcludeField,
  memory: MemoryField,
  'history.maxItems': HistoryMaxItemsField,
};

//#endregion

//#region Helpers

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
  const field = CONFIG_FIELDS_BY_PATH[current];
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
