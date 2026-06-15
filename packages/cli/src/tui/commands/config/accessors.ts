import type { AgentConfig, AgentOverride, WorktreeConfig } from '../../../types/config.js';
import { PANEL_CONFIG_MAX, PANEL_CONFIG_MIN } from '../../layout/constants.js';
import type { AgentOverrideFieldName, ConfigFieldPath } from './types.js';
import { parseAgentOverrideFieldPath } from './types.js';

//#region Helpers

function cloneAgentOverrides(overrides: AgentConfig['agents']): AgentConfig['agents'] {
  if (!overrides) {
    return undefined;
  }
  const next: Record<string, AgentOverride> = {};
  for (const [agentType, override] of Object.entries(overrides)) {
    next[agentType] = {
      ...override,
      tools: override.tools
        ? [
            ...override.tools,
          ]
        : undefined,
    };
  }
  return next;
}

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
    history: config.history
      ? {
          ...config.history,
        }
      : undefined,
    agents: cloneAgentOverrides(config.agents),
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

function parseMultilineValue(rawValue: string): string {
  return rawValue.replaceAll('\\n', '\n');
}

function ensureAgentOverride(config: AgentConfig, agentType: string): AgentOverride {
  if (!config.agents) {
    config.agents = {};
  }
  const existing = config.agents[agentType];
  if (existing) {
    return existing;
  }
  const fresh: AgentOverride = {};
  config.agents[agentType] = fresh;
  return fresh;
}

function pruneAgentOverride(config: AgentConfig, agentType: string): void {
  if (!config.agents) {
    return;
  }
  const override = config.agents[agentType];
  if (!override) {
    return;
  }
  const isEmpty =
    override.model === undefined &&
    override.instructions === undefined &&
    override.instructionsMode === undefined &&
    (override.tools === undefined || override.tools.length === 0);
  if (!isEmpty) {
    return;
  }
  delete config.agents[agentType];
  if (Object.keys(config.agents).length === 0) {
    config.agents = undefined;
  }
}

//#endregion

//#region Getters

export function getFieldValue(config: AgentConfig, path: ConfigFieldPath): string {
  const agentPath = parseAgentOverrideFieldPath(path);
  if (agentPath) {
    return getAgentFieldValue(config, agentPath.agentType, agentPath.field);
  }
  const getter = staticFieldGetters[path];
  if (!getter) {
    return '';
  }
  const value = getter(config);
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

function getAgentFieldValue(
  config: AgentConfig,
  agentType: string,
  field: AgentOverrideFieldName,
): string {
  const override = config.agents?.[agentType];
  if (!override) {
    return '';
  }
  if (field === 'model') {
    return override.model ?? '';
  }
  if (field === 'instructions') {
    return override.instructions ?? '';
  }
  return (override.tools ?? []).join(', ');
}

type StaticFieldGetter = (config: AgentConfig) => string | number | boolean | string[] | undefined;

const staticFieldGetters: Record<string, StaticFieldGetter> = {
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
  'history.maxItems': (config) => config.history?.maxItems,
  'ui.contextPanelWidth': (config) => {
    const value = config.ui?.contextPanelWidth;
    if (value === undefined) {
      return 'responsive';
    }
    return typeof value === 'number' ? value.toString() : value;
  },
};

//#endregion

//#region Setters

export function setFieldValue(
  config: AgentConfig,
  path: ConfigFieldPath,
  rawValue: string,
): AgentConfig {
  const next = cloneConfig(config);
  const agentPath = parseAgentOverrideFieldPath(path);
  if (agentPath) {
    setAgentFieldValue({
      config: next,
      agentType: agentPath.agentType,
      field: agentPath.field,
      rawValue,
    });
    return next;
  }
  const setter = staticFieldSetters[path];
  if (!setter) {
    return next;
  }
  setter(next, rawValue);
  return next;
}

interface SetAgentFieldValueArgs {
  config: AgentConfig;
  agentType: string;
  field: AgentOverrideFieldName;
  rawValue: string;
}

function setAgentFieldValue(args: SetAgentFieldValueArgs): void {
  const { config, agentType, field, rawValue } = args;
  const override = ensureAgentOverride(config, agentType);
  if (field === 'model') {
    const trimmed = rawValue.trim();
    override.model = trimmed.length > 0 ? trimmed : undefined;
  } else if (field === 'instructions') {
    const value = parseMultilineValue(rawValue);
    override.instructions = value.length > 0 ? value : undefined;
  } else {
    const values = splitList(rawValue);
    override.tools = values.length > 0 ? values : undefined;
  }
  pruneAgentOverride(config, agentType);
}

type StaticFieldSetter = (config: AgentConfig, rawValue: string) => void;

const staticFieldSetters: Record<string, StaticFieldSetter> = {
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
    const value = parseMultilineValue(rawValue);
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
  'history.maxItems': (config, rawValue) => {
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) {
      config.history = undefined;
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return;
    }
    config.history = {
      maxItems: parsed,
    };
  },
  'ui.contextPanelWidth': (config, rawValue) => {
    const trimmed = rawValue.trim();
    if (trimmed.length === 0 || trimmed === 'responsive') {
      config.ui = {
        ...config.ui,
        contextPanelWidth: 'responsive',
      };
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return;
    }
    const clamped = Math.max(PANEL_CONFIG_MIN, Math.min(PANEL_CONFIG_MAX, Math.trunc(parsed)));
    config.ui = {
      ...config.ui,
      contextPanelWidth: clamped,
    };
  },
};

function parseCleanup(rawValue: string): WorktreeConfig['cleanup'] {
  if (rawValue === 'always' || rawValue === 'never') {
    return rawValue;
  }
  return 'if-clean';
}

//#endregion
