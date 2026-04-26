import type { AgentConfig } from '../../../types/config.js';

//#region Types

export const ConfigTab = {
  Model: 'model',
  Tools: 'tools',
  Memory: 'memory',
  Runtime: 'runtime',
  Worktree: 'worktree',
} as const;
export type ConfigTab = (typeof ConfigTab)[keyof typeof ConfigTab];

export const CONFIG_TAB_TITLES: Record<ConfigTab, string> = {
  [ConfigTab.Model]: 'Model',
  [ConfigTab.Tools]: 'Tools & Plugins',
  [ConfigTab.Memory]: 'Memory',
  [ConfigTab.Runtime]: 'Runtime',
  [ConfigTab.Worktree]: 'Worktree',
};

export const CONFIG_TAB_ORDER: ReadonlyArray<ConfigTab> = [
  ConfigTab.Model,
  ConfigTab.Tools,
  ConfigTab.Memory,
  ConfigTab.Runtime,
  ConfigTab.Worktree,
];

export type ConfigFieldPath =
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
  | 'memory';

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

//#endregion
