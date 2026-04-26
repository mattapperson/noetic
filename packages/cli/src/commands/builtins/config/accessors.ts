import type { AgentConfig, WorktreeConfig } from '../../../types/config.js';
import type { ConfigFieldPath } from './types.js';

//#region Helpers

function cloneConfig(config: AgentConfig): AgentConfig {
  return {
    ...config,
    plugins: config.plugins
      ? [
          ...config.plugins,
        ]
      : undefined,
    tools: config.tools
      ? {
          include: config.tools.include
            ? [
                ...config.tools.include,
              ]
            : undefined,
          exclude: config.tools.exclude
            ? [
                ...config.tools.exclude,
              ]
            : undefined,
        }
      : undefined,
    memory: config.memory
      ? [
          ...config.memory,
        ]
      : undefined,
    worktree: config.worktree
      ? {
          ...config.worktree,
          'clone-files': config.worktree['clone-files']
            ? [
                ...config.worktree['clone-files'],
              ]
            : undefined,
        }
      : undefined,
  };
}

function ensureWorktree(config: AgentConfig): WorktreeConfig {
  return config.worktree ?? {};
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

//#endregion

//#region Getters

export function getFieldValue(config: AgentConfig, path: ConfigFieldPath): string {
  const value = fieldGetters[path](config);
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return value.toString();
  }
  return value ?? '';
}

const fieldGetters: Record<
  ConfigFieldPath,
  (config: AgentConfig) => string | number | boolean | string[] | undefined
> = {
  model: (config) => config.model,
  apiKey: (config) => config.apiKey,
  maxTurns: (config) => config.maxTurns,
  systemPromptMode: (config) => config.systemPromptMode ?? 'compose',
  systemPrompt: (config) => config.systemPrompt,
  cwd: (config) => config.cwd,
  trustProjectEmbeddedCommands: (config) => config.trustProjectEmbeddedCommands ?? false,
  'worktree.enabled': (config) => config.worktree !== undefined,
  'worktree.worktree-path': (config) => config.worktree?.['worktree-path'],
  'worktree.branch': (config) => config.worktree?.branch,
  'worktree.cleanup': (config) => config.worktree?.cleanup ?? 'if-clean',
  'worktree.clone-files': (config) => config.worktree?.['clone-files'] ?? [],
  'tools.include': (config) => config.tools?.include ?? [],
  'tools.exclude': (config) => config.tools?.exclude ?? [],
  memory: (config) => config.memory ?? [],
};

//#endregion

//#region Setters

export function setFieldValue(
  config: AgentConfig,
  path: ConfigFieldPath,
  rawValue: string,
): AgentConfig {
  const next = cloneConfig(config);
  fieldSetters[path](next, rawValue);
  return next;
}

const fieldSetters: Record<ConfigFieldPath, (config: AgentConfig, rawValue: string) => void> = {
  model: (config, rawValue) => {
    config.model = rawValue.trim();
  },
  apiKey: (config, rawValue) => {
    config.apiKey = rawValue;
  },
  maxTurns: (config, rawValue) => {
    config.maxTurns = Number(rawValue);
  },
  systemPromptMode: (config, rawValue) => {
    config.systemPromptMode = rawValue === 'replace' ? 'replace' : 'compose';
  },
  systemPrompt: (config, rawValue) => {
    const value = rawValue.replaceAll('\\n', '\n');
    config.systemPrompt = value.length > 0 ? value : undefined;
  },
  cwd: (config, rawValue) => {
    config.cwd = rawValue.trim();
  },
  trustProjectEmbeddedCommands: (config, rawValue) => {
    config.trustProjectEmbeddedCommands = rawValue === 'true';
  },
  'worktree.enabled': (config, rawValue) => {
    config.worktree = rawValue === 'true' ? ensureWorktree(config) : undefined;
  },
  'worktree.worktree-path': (config, rawValue) => {
    const worktree = ensureWorktree(config);
    worktree['worktree-path'] = rawValue.trim() || undefined;
    config.worktree = worktree;
  },
  'worktree.branch': (config, rawValue) => {
    const worktree = ensureWorktree(config);
    worktree.branch = rawValue.trim() || undefined;
    config.worktree = worktree;
  },
  'worktree.cleanup': (config, rawValue) => {
    const worktree = ensureWorktree(config);
    worktree.cleanup = parseCleanup(rawValue);
    config.worktree = worktree;
  },
  'worktree.clone-files': (config, rawValue) => {
    const values = splitList(rawValue);
    const worktree = ensureWorktree(config);
    worktree['clone-files'] = values.length > 0 ? values : undefined;
    config.worktree = worktree;
  },
  'tools.include': (config, rawValue) => {
    const values = splitList(rawValue);
    config.tools = {
      ...config.tools,
      include: values.length > 0 ? values : undefined,
    };
  },
  'tools.exclude': (config, rawValue) => {
    const values = splitList(rawValue);
    config.tools = {
      ...config.tools,
      exclude: values.length > 0 ? values : undefined,
    };
  },
  memory: (config, rawValue) => {
    const values = splitList(rawValue);
    config.memory = values.length > 0 ? values : undefined;
  },
};

function parseCleanup(rawValue: string): WorktreeConfig['cleanup'] {
  if (rawValue === 'always' || rawValue === 'never') {
    return rawValue;
  }
  return 'if-clean';
}

//#endregion
