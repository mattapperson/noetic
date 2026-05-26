import type { AgentConfig } from '../../../types/config.js';
import type { ConfigFieldPath } from './types.js';

//#region Public API

export function serializeConfig(
  config: AgentConfig,
  editedFields: ReadonlySet<ConfigFieldPath> = new Set(),
): string {
  const body = serializeValue(pruneUndefined(cleanConfig(config, editedFields)), 0);
  return `import type { AgentConfig } from '@noetic/cli';\n\nexport default ${body} satisfies AgentConfig;\n`;
}

//#endregion

//#region Helpers

function cleanConfig(
  config: AgentConfig,
  editedFields: ReadonlySet<ConfigFieldPath>,
): Partial<AgentConfig> {
  return {
    model: config.model,
    cwd: config.cwd,
    apiKey: editedFields.has('apiKey') ? config.apiKey : 'process.env.OPENROUTER_API_KEY ?? ""',
    maxTurns: config.maxTurns,
    systemPrompt: config.systemPrompt,
    systemPromptMode: config.systemPromptMode,
    trustProjectEmbeddedCommands: config.trustProjectEmbeddedCommands,
    plugins: config.plugins,
    tools: cleanTools(config),
    memory: config.memory,
    worktree: cleanWorktree(config),
    history: config.history,
    setup: config.setup,
    agents: config.agents,
  };
}

function cleanTools(config: AgentConfig): AgentConfig['tools'] {
  if (!config.tools) {
    return undefined;
  }
  return {
    include: config.tools.include,
    exclude: config.tools.exclude,
  };
}

function cleanWorktree(config: AgentConfig): AgentConfig['worktree'] {
  if (!config.worktree) {
    return undefined;
  }
  return {
    'worktree-path': config.worktree['worktree-path'],
    branch: config.worktree.branch,
    'pre-start': config.worktree['pre-start'],
    'post-start': config.worktree['post-start'],
    'post-merge': config.worktree['post-merge'],
    'pre-remove': config.worktree['pre-remove'],
    'clone-files': config.worktree['clone-files'],
    cleanup: config.worktree.cleanup,
  };
}

function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(pruneUndefined);
  }
  if (!isSerializableObject(value)) {
    return value;
  }
  const entries = Object.entries(value)
    .filter((entry) => entry[1] !== undefined)
    .map(([key, item]) => [
      key,
      pruneUndefined(item),
    ]);
  return Object.fromEntries(entries);
}

function serializeValue(value: unknown, indent: number): string {
  if (value === 'process.env.OPENROUTER_API_KEY ?? ""') {
    return value;
  }
  if (Array.isArray(value)) {
    return serializeArray(value, indent);
  }
  if (isSerializableObject(value)) {
    return serializeObject(value, indent);
  }
  return JSON.stringify(value);
}

function isSerializableObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function serializeArray(values: ReadonlyArray<unknown>, indent: number): string {
  if (values.length === 0) {
    return '[]';
  }
  const childIndent = ' '.repeat(indent + 2);
  const closingIndent = ' '.repeat(indent);
  const lines = values.map((value) => `${childIndent}${serializeValue(value, indent + 2)},`);
  return `[\n${lines.join('\n')}\n${closingIndent}]`;
}

function serializeObject(value: Record<string, unknown>, indent: number): string {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return '{}';
  }
  const childIndent = ' '.repeat(indent + 2);
  const closingIndent = ' '.repeat(indent);
  const lines = entries.map(
    ([key, item]) => `${childIndent}${serializeKey(key)}: ${serializeValue(item, indent + 2)},`,
  );
  return `{\n${lines.join('\n')}\n${closingIndent}}`;
}

function serializeKey(key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    return key;
  }
  return JSON.stringify(key);
}

//#endregion
