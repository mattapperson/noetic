/**
 * /config command — Tab-based configuration viewer.
 */

import { Box, Text, useInput } from 'ink';
import type { FC, ReactNode } from 'react';

import { Tab, Tabs } from '../../tui/components/tabs/index.js';
import type { Theme } from '../../tui/components/theme.js';
import { useTheme } from '../../tui/components/theme.js';
import type { AgentConfig, PluginSpec } from '../../types/config.js';
import type { Command, LocalJsxCommandCall } from '../types.js';

//#region Types & constants

const ConfigTab = {
  Model: 'model',
  Tools: 'tools',
  Memory: 'memory',
  Runtime: 'runtime',
  Worktree: 'worktree',
} as const;
type ConfigTab = (typeof ConfigTab)[keyof typeof ConfigTab];

const CONFIG_TAB_TITLES: Record<ConfigTab, string> = {
  [ConfigTab.Model]: 'Model',
  [ConfigTab.Tools]: 'Tools & Plugins',
  [ConfigTab.Memory]: 'Memory',
  [ConfigTab.Runtime]: 'Runtime',
  [ConfigTab.Worktree]: 'Worktree',
};

const CONFIG_TAB_ORDER: ReadonlyArray<ConfigTab> = [
  ConfigTab.Model,
  ConfigTab.Tools,
  ConfigTab.Memory,
  ConfigTab.Runtime,
  ConfigTab.Worktree,
];

const DEFAULT_SYSTEM_PROMPT_MODE = 'compose';
const DEFAULT_CLEANUP_POLICY = 'if-clean';
const COMING_SOON_NOTE = 'This is a read-only view. Configuration editing coming soon.';

interface LabelledItem {
  label: string;
  description: string;
}

const BUILTIN_MEMORY_LAYERS: ReadonlyArray<LabelledItem> = [
  {
    label: 'Working Memory',
    description: 'Short-term context',
  },
  {
    label: 'Episodic Memory',
    description: 'Long-term conversation storage',
  },
  {
    label: 'Semantic Recall',
    description: 'Vector-based search',
  },
  {
    label: 'Observational Memory',
    description: 'Pattern tracking',
  },
  {
    label: 'Durable Task State',
    description: 'Persistent task data',
  },
  {
    label: 'Skills Layer',
    description: 'Available skills',
  },
  {
    label: 'Agent.md Layer',
    description: 'Project instructions',
  },
];

const WORKTREE_BENEFITS: ReadonlyArray<LabelledItem> = [
  {
    label: 'Safety',
    description: "Agent changes don't affect your main workspace",
  },
  {
    label: 'Parallel',
    description: 'Run multiple agents simultaneously',
  },
  {
    label: 'Experimental',
    description: 'Safe environment for trying changes',
  },
  {
    label: 'Clean',
    description: 'Each session starts with a clean state',
  },
];

interface ConfigFieldProps {
  label: string;
  value: string;
  placeholder?: string;
  description?: string;
}

interface ConfigSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
}

interface PanelProps {
  config: AgentConfig;
}

type ThemeColor = Theme[Exclude<keyof Theme, 'isDark'>];

//#endregion

//#region Helpers

function maskApiKey(key: string): string {
  if (key.length <= 8) {
    return key;
  }
  return `${key.substring(0, 4)}${'•'.repeat(key.length - 8)}${key.substring(key.length - 4)}`;
}

function getPluginName(plugin: PluginSpec): string {
  return typeof plugin === 'string' ? plugin : plugin.name;
}

function getPluginVersion(plugin: PluginSpec): string {
  if (typeof plugin === 'string') {
    return 'local';
  }
  // PluginSpec has two object variants — only one carries `version`.
  // Runtime check is required to discriminate at use sites.
  return 'version' in plugin ? `v${plugin.version}` : 'local';
}

function parseInitialTab(args: string): ConfigTab {
  const trimmed = args.trim().toLowerCase();
  if (!trimmed) {
    return ConfigTab.Model;
  }
  const exact = CONFIG_TAB_ORDER.find((id) => id === trimmed);
  if (exact) {
    return exact;
  }
  const prefix = CONFIG_TAB_ORDER.find((id) => id.startsWith(trimmed));
  return prefix ?? ConfigTab.Model;
}

//#endregion

//#region Presentation primitives

function ConfigField({ label, value, placeholder, description }: ConfigFieldProps): ReactNode {
  const theme = useTheme();
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row">
        <Box width={20}>
          <Text bold color={theme.accent}>
            {label}:
          </Text>
        </Box>
        <Box flexDirection="column">
          <Box borderStyle="single" borderColor={theme.border} paddingX={1} width={40}>
            <Text>{value || <Text dimColor>{placeholder}</Text>}</Text>
          </Box>
          {description && <Text dimColor>{description}</Text>}
        </Box>
      </Box>
    </Box>
  );
}

function ConfigSection({ title, description, children }: ConfigSectionProps): ReactNode {
  const theme = useTheme();
  return (
    <Box flexDirection="column" marginBottom={2}>
      <Text bold color={theme.accent}>
        {title}
      </Text>
      {description && <Text dimColor>{description}</Text>}
      <Box flexDirection="column" paddingLeft={2} marginTop={description ? 1 : 0}>
        {children}
      </Box>
    </Box>
  );
}

function ConfigPanel({ children }: { children: ReactNode }): ReactNode {
  return (
    <Box flexDirection="column">
      {children}
      <Text dimColor>{COMING_SOON_NOTE}</Text>
    </Box>
  );
}

function LabelledList({ items }: { items: ReadonlyArray<LabelledItem> }): ReactNode {
  return (
    <>
      {items.map((item) => (
        <Text key={item.label} dimColor>
          • <Text bold>{item.label}</Text> — {item.description}
        </Text>
      ))}
    </>
  );
}

//#endregion

//#region Panels

function ModelPanel({ config }: PanelProps): ReactNode {
  return (
    <ConfigPanel>
      <ConfigSection title="Model Settings" description="Configure the AI model and API access">
        <ConfigField
          label="Model"
          value={config.model || ''}
          placeholder="e.g., anthropic/claude-sonnet-4"
          description="OpenRouter model identifier"
        />
        <ConfigField
          label="API Key"
          value={maskApiKey(config.apiKey || '')}
          placeholder="Enter your OpenRouter API key"
          description="Your OpenRouter API key for model access"
        />
        <ConfigField
          label="Max Turns"
          value={config.maxTurns?.toString() || ''}
          placeholder="50"
          description="Maximum conversation turns before stopping"
        />
      </ConfigSection>

      <ConfigSection title="System Prompt" description="Customize the agent's instructions">
        <ConfigField
          label="System Prompt Mode"
          value={config.systemPromptMode || DEFAULT_SYSTEM_PROMPT_MODE}
          description={
            config.systemPromptMode === 'replace'
              ? 'Your prompt will completely replace the built-in prompt'
              : 'Your prompt will be combined with the built-in prompt'
          }
        />
        <ConfigField
          label="Custom System Prompt"
          value={config.systemPrompt || ''}
          placeholder="Enter custom instructions for the agent..."
          description="Additional instructions to guide the agent's behavior"
        />
      </ConfigSection>
    </ConfigPanel>
  );
}

interface ToolListProps {
  items: ReadonlyArray<string>;
  emptyText: string;
  color: ThemeColor;
}

function ToolList({ items, emptyText, color }: ToolListProps): ReactNode {
  if (items.length === 0) {
    return (
      <Box marginLeft={2}>
        <Text dimColor>{emptyText}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginLeft={2}>
      {items.map((toolName) => (
        <Text key={toolName} color={color}>
          • {toolName}
        </Text>
      ))}
    </Box>
  );
}

function ToolsPanel({ config }: PanelProps): ReactNode {
  const theme = useTheme();
  const plugins = config.plugins ?? [];
  const include = config.tools?.include ?? [];
  const exclude = config.tools?.exclude ?? [];

  return (
    <ConfigPanel>
      <ConfigSection title="Installed Plugins" description="Manage agent plugins and extensions">
        {plugins.length === 0 ? (
          <Text dimColor>No plugins installed</Text>
        ) : (
          plugins.map((plugin) => {
            const name = getPluginName(plugin);
            const version = getPluginVersion(plugin);
            return (
              <Box key={name} flexDirection="row" marginBottom={1}>
                <Text color={theme.success}>[on] </Text>
                <Text>{name}</Text>
                <Text dimColor> {version}</Text>
              </Box>
            );
          })
        )}
      </ConfigSection>

      <ConfigSection title="Tool Configuration" description="Control which tools are available">
        <Text bold>Included Tools:</Text>
        <ToolList items={include} emptyText="All tools included by default" color={theme.success} />

        <Box marginTop={1}>
          <Text bold>Excluded Tools:</Text>
        </Box>
        <ToolList items={exclude} emptyText="No tools excluded" color={theme.error} />
      </ConfigSection>
    </ConfigPanel>
  );
}

function MemoryPanel({ config }: PanelProps): ReactNode {
  const theme = useTheme();
  const memoryLayers = config.memory ?? [];

  return (
    <ConfigPanel>
      <ConfigSection
        title="Active Memory Layers"
        description="Configure how the agent remembers information"
      >
        {memoryLayers.length === 0 ? (
          <Text dimColor>Using default memory configuration</Text>
        ) : (
          memoryLayers.map((layer, index) => (
            <Box key={layer} flexDirection="row" marginBottom={1}>
              <Text color={theme.accent}>#{index + 1} </Text>
              <Text bold>{layer}</Text>
            </Box>
          ))
        )}
      </ConfigSection>

      <ConfigSection title="Available Memory Layers" description="Built-in memory layer types">
        <LabelledList items={BUILTIN_MEMORY_LAYERS} />
      </ConfigSection>
    </ConfigPanel>
  );
}

function RuntimePanel({ config }: PanelProps): ReactNode {
  const theme = useTheme();
  const trustsProjectCommands = config.trustProjectEmbeddedCommands === true;

  return (
    <ConfigPanel>
      <ConfigSection title="Environment Settings" description="Runtime environment configuration">
        <ConfigField
          label="Working Directory"
          value={config.cwd || ''}
          placeholder="/path/to/project"
          description="Base directory where the agent operates"
        />
      </ConfigSection>

      <ConfigSection title="Security & Trust" description="Security and trust policies">
        <Box flexDirection="row" marginBottom={1}>
          <Text>Project Commands: </Text>
          <Text color={trustsProjectCommands ? theme.success : theme.error}>
            {trustsProjectCommands ? 'Enabled' : 'Disabled'}
          </Text>
        </Box>
        <Text dimColor>
          {trustsProjectCommands
            ? 'Project AGENT.md files can execute !commands at session start'
            : 'Project AGENT.md files cannot execute !commands (safer)'}
        </Text>
      </ConfigSection>
    </ConfigPanel>
  );
}

function WorktreePanel({ config }: PanelProps): ReactNode {
  const theme = useTheme();
  const worktreeConfig = config.worktree;

  return (
    <ConfigPanel>
      <ConfigSection title="Worktree Isolation" description="Git worktree isolation configuration">
        <Box flexDirection="row" marginBottom={1}>
          <Text>Isolation Mode: </Text>
          <Text color={worktreeConfig ? theme.success : theme.error}>
            {worktreeConfig ? 'Enabled' : 'Disabled'}
          </Text>
        </Box>

        {worktreeConfig && (
          <Box flexDirection="column" marginTop={1}>
            <ConfigField
              label="Worktree Path"
              value={worktreeConfig['worktree-path'] || ''}
              placeholder="{{ repo_path }}/.worktrees/{{ worktree_name | sanitize }}"
              description="Template for worktree directory paths"
            />
            <ConfigField
              label="Branch Name"
              value={worktreeConfig.branch || ''}
              placeholder="{{ agent_id | sanitize }}"
              description="Template for worktree branch names"
            />
            <ConfigField
              label="Cleanup Policy"
              value={worktreeConfig.cleanup ?? DEFAULT_CLEANUP_POLICY}
              description="When to automatically clean up worktrees"
            />
          </Box>
        )}
      </ConfigSection>

      <ConfigSection title="Worktree Benefits" description="Why use worktree isolation?">
        <LabelledList items={WORKTREE_BENEFITS} />
      </ConfigSection>
    </ConfigPanel>
  );
}

//#endregion

//#region Container

const PANEL_COMPONENTS: Record<ConfigTab, FC<PanelProps>> = {
  [ConfigTab.Model]: ModelPanel,
  [ConfigTab.Tools]: ToolsPanel,
  [ConfigTab.Memory]: MemoryPanel,
  [ConfigTab.Runtime]: RuntimePanel,
  [ConfigTab.Worktree]: WorktreePanel,
};

interface ConfigViewerProps {
  initialTab: ConfigTab;
  config: AgentConfig;
  onCancel: () => void;
}

function ConfigViewer({ initialTab, config, onCancel }: ConfigViewerProps): ReactNode {
  const theme = useTheme();

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" padding={1}>
        <Text bold color={theme.accent}>
          Agent Configuration
        </Text>
        <Box height={1} />

        <Tabs defaultTab={initialTab} color={theme.accent}>
          {CONFIG_TAB_ORDER.map((id) => {
            const Panel = PANEL_COMPONENTS[id];
            return (
              <Tab key={id} id={id} title={CONFIG_TAB_TITLES[id]}>
                <Panel config={config} />
              </Tab>
            );
          })}
        </Tabs>

        <Box marginTop={1}>
          <Text dimColor>Tab/Shift+Tab: navigate tabs • Esc: close</Text>
        </Box>
      </Box>
    </Box>
  );
}

//#endregion

//#region Command

const call: LocalJsxCommandCall = async (onDone, ctx, args): Promise<ReactNode> => {
  const initialTab = parseInitialTab(args);
  const handleCancel = (): void => {
    onDone('Configuration viewer closed');
  };
  return <ConfigViewer initialTab={initialTab} config={ctx.config} onCancel={handleCancel} />;
};

export const config: Command = {
  type: 'local-jsx',
  name: 'config',
  description: 'View agent configuration',
  load: async () => ({
    call,
  }),
};

//#endregion
