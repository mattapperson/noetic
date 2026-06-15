import type { AgentConfig } from '../../../types/config.js';

//#region Types

export const ConfigTab = {
  Model: 'model',
  Tools: 'tools',
  Memory: 'memory',
  Runtime: 'runtime',
  Worktree: 'worktree',
  Agents: 'agents',
} as const;
export type ConfigTab = (typeof ConfigTab)[keyof typeof ConfigTab];

export const CONFIG_TAB_TITLES: Record<ConfigTab, string> = {
  [ConfigTab.Model]: 'Model',
  [ConfigTab.Tools]: 'Tools & Plugins',
  [ConfigTab.Memory]: 'Memory',
  [ConfigTab.Runtime]: 'Runtime',
  [ConfigTab.Worktree]: 'Worktree',
  [ConfigTab.Agents]: 'Sub-agents',
};

export const CONFIG_TAB_ORDER: ReadonlyArray<ConfigTab> = [
  ConfigTab.Model,
  ConfigTab.Agents,
  ConfigTab.Tools,
  ConfigTab.Memory,
  ConfigTab.Runtime,
  ConfigTab.Worktree,
];

/**
 * Static field paths cover every editable AgentConfig field except per-sub-agent
 * overrides. Sub-agent overrides use the template-literal slot
 * `agents.{type}.{field}` — the `type` portion is the agent-type id from a
 * registered skill, dynamic at runtime, so we widen that segment to `string`.
 */
export type AgentOverrideFieldName = 'model' | 'instructions' | 'tools';
export type AgentOverrideFieldPath = `agents.${string}.${AgentOverrideFieldName}`;

export type StaticConfigFieldPath =
  | 'model'
  | 'apiKey'
  | 'maxTurns'
  | 'systemPromptMode'
  | 'systemPrompt'
  | 'cwd'
  | 'trustProjectEmbeddedCommands'
  | 'worktree.enabled'
  | 'worktree.worktree-path'
  | 'worktree.branch'
  | 'worktree.cleanup'
  | 'worktree.clone-files'
  | 'tools.include'
  | 'tools.exclude'
  | 'memory'
  | 'history.maxItems'
  | 'ui.contextPanelWidth';

export type ConfigFieldPath = StaticConfigFieldPath | AgentOverrideFieldPath;

export const FieldKind = {
  Text: 'text',
  MaskedText: 'masked-text',
  Number: 'number',
  Boolean: 'boolean',
  Select: 'select',
  List: 'list',
  Multiline: 'multiline',
} as const;
export type FieldKind = (typeof FieldKind)[keyof typeof FieldKind];

export interface ConfigFieldDefinition {
  path: ConfigFieldPath;
  label: string;
  kind: FieldKind;
  tab: ConfigTab;
  description?: string;
  placeholder?: string;
  options?: ReadonlyArray<string>;
}

export const EditorMode = {
  Navigate: 'navigate',
  Edit: 'edit',
  ConfirmClose: 'confirm-close',
  ConfirmRewrite: 'confirm-rewrite',
  ConfirmCreate: 'confirm-create',
  Saving: 'saving',
} as const;
export type EditorMode = (typeof EditorMode)[keyof typeof EditorMode];

export interface ConfigEditorState {
  originalConfig: AgentConfig;
  draftConfig: AgentConfig;
  selectedTab: ConfigTab;
  focusedField: ConfigFieldPath;
  mode: EditorMode;
  editValue: string;
  dirtyFields: ReadonlySet<ConfigFieldPath>;
  validationErrors: ReadonlyMap<ConfigFieldPath, string>;
  globalError?: string;
  globalMessage?: string;
  saveConfirmed: boolean;
}

export interface ConfigEditorProps {
  initialTab: ConfigTab;
  config: AgentConfig;
  sourcePath?: string;
  onCancel: (message?: string) => void;
}

/**
 * Parse `agents.{type}.{field}` into its components, or return null if the
 * path is not an agent-override path. Accepts an arbitrary string so it can
 * narrow Zod issue paths (raw strings) as well as known `ConfigFieldPath`s.
 */
export function parseAgentOverrideFieldPath(path: string): {
  agentType: string;
  field: AgentOverrideFieldName;
} | null {
  if (!path.startsWith('agents.')) {
    return null;
  }
  const rest = path.slice('agents.'.length);
  const lastDot = rest.lastIndexOf('.');
  if (lastDot === -1) {
    return null;
  }
  const agentType = rest.slice(0, lastDot);
  const fieldName = rest.slice(lastDot + 1);
  if (fieldName !== 'model' && fieldName !== 'instructions' && fieldName !== 'tools') {
    return null;
  }
  return {
    agentType,
    field: fieldName,
  };
}

//#endregion
