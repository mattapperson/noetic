import type { AgentConfig, PluginSpec } from '../../../types/config.js';
import { AgentConfigSchema } from '../../../types/config.js';
import { CONFIG_FIELDS_BY_PATH } from './fields.js';
import type { ConfigFieldPath } from './types.js';

//#region Field Validation

export function validateField(path: ConfigFieldPath, rawValue: string): string | undefined {
  return fieldValidators[path](rawValue);
}

const fieldValidators: Record<ConfigFieldPath, (rawValue: string) => string | undefined> = {
  model: validateRequired,
  apiKey: validateRequired,
  maxTurns: validatePositiveInteger,
  systemPromptMode: (rawValue) => validateOption('systemPromptMode', rawValue),
  systemPrompt: () => undefined,
  cwd: validateRequired,
  trustProjectEmbeddedCommands: validateBoolean,
  'worktree.enabled': validateBoolean,
  'worktree.worktree-path': () => undefined,
  'worktree.branch': () => undefined,
  'worktree.cleanup': (rawValue) => validateOption('worktree.cleanup', rawValue),
  'worktree.clone-files': validateList,
  'tools.include': validateList,
  'tools.exclude': validateList,
  memory: validateList,
  'history.maxItems': validateOptionalIntInRange(2, 1e4),
};

function validateRequired(rawValue: string): string | undefined {
  if (rawValue.trim().length > 0) {
    return undefined;
  }
  return 'Required';
}

function validatePositiveInteger(rawValue: string): string | undefined {
  const value = Number(rawValue);
  if (Number.isInteger(value) && value > 0) {
    return undefined;
  }
  return 'Must be a positive integer';
}

function validateBoolean(rawValue: string): string | undefined {
  if (rawValue === 'true' || rawValue === 'false') {
    return undefined;
  }
  return 'Must be true or false';
}

function validateOption(path: ConfigFieldPath, rawValue: string): string | undefined {
  const options = CONFIG_FIELDS_BY_PATH[path].options ?? [];
  if (options.includes(rawValue)) {
    return undefined;
  }
  return `Must be one of: ${options.join(', ')}`;
}

function validateList(rawValue: string): string | undefined {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const hasEmptyItem = trimmed.split(',').some((item) => item.trim().length === 0);
  if (!hasEmptyItem) {
    return undefined;
  }
  return 'List contains an empty entry';
}

function validateOptionalIntInRange(
  min: number,
  max: number,
): (rawValue: string) => string | undefined {
  return (rawValue) => {
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const value = Number(trimmed);
    if (Number.isInteger(value) && value >= min && value <= max) {
      return undefined;
    }
    return `Must be an integer between ${min} and ${max} (or empty to disable)`;
  };
}

//#endregion

//#region Config Validation

export function validateConfig(config: AgentConfig): ReadonlyMap<ConfigFieldPath, string> {
  const result = AgentConfigSchema.safeParse(config);
  const errors = new Map<ConfigFieldPath, string>();
  const pluginError = validatePluginsSerializable(config.plugins);
  if (pluginError) {
    errors.set('tools.include', pluginError);
  }
  if (result.success) {
    return errors;
  }

  for (const issue of result.error.issues) {
    const fieldPath = toFieldPath(issue.path);
    errors.set(fieldPath, issue.message);
  }
  return errors;
}

function validatePluginsSerializable(
  plugins: ReadonlyArray<PluginSpec> | undefined,
): string | undefined {
  if (!plugins) {
    return undefined;
  }
  const hasUnsafePlugin = plugins.some((plugin) => !isSerializablePluginSpec(plugin));
  if (!hasUnsafePlugin) {
    return undefined;
  }
  return 'Cannot save config with runtime plugin instances or function-valued plugin options';
}

function isSerializablePluginSpec(plugin: PluginSpec): boolean {
  if (typeof plugin === 'string') {
    return true;
  }
  return isJsonSerializable(plugin);
}

function isJsonSerializable(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonSerializable);
  }
  if (typeof value !== 'object') {
    return false;
  }
  return Object.values(value).every(isJsonSerializable);
}

function toFieldPath(path: ReadonlyArray<PropertyKey>): ConfigFieldPath {
  const joined = path.join('.');
  const mapped = schemaPathMap[joined];
  if (mapped) {
    return mapped;
  }
  return 'model';
}

const schemaPathMap: Record<string, ConfigFieldPath> = {
  model: 'model',
  apiKey: 'apiKey',
  maxTurns: 'maxTurns',
  systemPrompt: 'systemPrompt',
  systemPromptMode: 'systemPromptMode',
  cwd: 'cwd',
  trustProjectEmbeddedCommands: 'trustProjectEmbeddedCommands',
  'worktree.worktree-path': 'worktree.worktree-path',
  'worktree.branch': 'worktree.branch',
  'worktree.cleanup': 'worktree.cleanup',
  'worktree.clone-files': 'worktree.clone-files',
  'tools.include': 'tools.include',
  'tools.exclude': 'tools.exclude',
  memory: 'memory',
  'history.maxItems': 'history.maxItems',
};

//#endregion
