import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import type { Theme } from '../../../tui/components/theme.js';
import { useTheme } from '../../../tui/components/theme.js';
import { getFieldValue } from './accessors.js';
import { getFieldsForTab, requireFieldByPath } from './fields.js';
import type { ConfigEditorState, ConfigFieldDefinition } from './types.js';
import { ConfigTab, FieldKind } from './types.js';

//#region Types

interface PanelProps {
  state: ConfigEditorState;
}

interface FieldRowProps {
  field: ConfigFieldDefinition;
  state: ConfigEditorState;
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

function formatFieldValue(field: ConfigFieldDefinition, state: ConfigEditorState): string {
  const value = getFieldValue(state.draftConfig, field.path);
  if (field.kind === FieldKind.MaskedText) {
    return maskApiKey(value);
  }
  if (field.kind === FieldKind.Multiline) {
    return value.replaceAll('\n', '\\n');
  }
  return value;
}

function getFieldColor(
  field: ConfigFieldDefinition,
  state: ConfigEditorState,
  theme: Theme,
): ThemeColor {
  if (state.validationErrors.has(field.path)) {
    return theme.error;
  }
  if (state.focusedField === field.path) {
    return theme.accent;
  }
  if (state.dirtyFields.has(field.path)) {
    return theme.warning;
  }
  return theme.border;
}

function renderEmpty(value: string, placeholder: string | undefined): ReactNode {
  if (value.length > 0) {
    return value;
  }
  return <Text dimColor>{placeholder ?? 'unset'}</Text>;
}

//#endregion

//#region Shared Components

function ConfigSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}): ReactNode {
  const theme = useTheme();
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={theme.accent}>
        {title}
      </Text>
      {description && <Text dimColor>{description}</Text>}
      <Box flexDirection="column" paddingLeft={2} marginTop={1}>
        {children}
      </Box>
    </Box>
  );
}

function FieldRow({ field, state }: FieldRowProps): ReactNode {
  const theme = useTheme();
  const isFocused = state.focusedField === field.path;
  const error = state.validationErrors.get(field.path);
  const color = getFieldColor(field, state, theme);
  const value = formatFieldValue(field, state);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row">
        <Box width={24}>
          <Text color={isFocused ? theme.accent : undefined} bold={isFocused}>
            {isFocused ? '› ' : '  '}
            {field.label}:
          </Text>
        </Box>
        <Box borderStyle="single" borderColor={color} paddingX={1} width={52}>
          <Text>{renderEmpty(value, field.placeholder)}</Text>
        </Box>
        {state.dirtyFields.has(field.path) && (
          <Box marginLeft={1}>
            <Text color={theme.warning}>modified</Text>
          </Box>
        )}
      </Box>
      {field.description && (
        <Box paddingLeft={26}>
          <Text dimColor>{field.description}</Text>
        </Box>
      )}
      {error && (
        <Box paddingLeft={26}>
          <Text color={theme.error}>{error}</Text>
        </Box>
      )}
    </Box>
  );
}

function EditableFields({ tab, state }: { tab: ConfigTab; state: ConfigEditorState }): ReactNode {
  return (
    <>
      {getFieldsForTab(tab).map((field) => (
        <FieldRow key={field.path} field={field} state={state} />
      ))}
    </>
  );
}

//#endregion

//#region Panels

export function ModelPanel({ state }: PanelProps): ReactNode {
  return (
    <ConfigSection title="Model Settings" description="Configure the AI model and instructions">
      <EditableFields tab={ConfigTab.Model} state={state} />
    </ConfigSection>
  );
}

export function ToolsPanel({ state }: PanelProps): ReactNode {
  const plugins = state.draftConfig.plugins ?? [];
  return (
    <>
      <ConfigSection title="Tool Configuration" description="Control which tools are available">
        <EditableFields tab={ConfigTab.Tools} state={state} />
      </ConfigSection>
      <ConfigSection
        title="Installed Plugins"
        description="Plugin editing is planned for a later pass"
      >
        {plugins.length === 0 ? (
          <Text dimColor>No plugins installed</Text>
        ) : (
          plugins.map((plugin) => {
            const name = typeof plugin === 'string' ? plugin : plugin.name;
            return <Text key={name}>• {name}</Text>;
          })
        )}
      </ConfigSection>
    </>
  );
}

export function MemoryPanel({ state }: PanelProps): ReactNode {
  return (
    <ConfigSection title="Memory Layers" description="Configure ordered memory layer names">
      <EditableFields tab={ConfigTab.Memory} state={state} />
    </ConfigSection>
  );
}

export function RuntimePanel({ state }: PanelProps): ReactNode {
  return (
    <ConfigSection title="Runtime Settings" description="Runtime environment and trust settings">
      <EditableFields tab={ConfigTab.Runtime} state={state} />
    </ConfigSection>
  );
}

export function AgentsPanel({ state }: PanelProps): ReactNode {
  if (getFieldsForTab(ConfigTab.Agents).length === 0) {
    return (
      <ConfigSection title="Sub-agents" description="Per-sub-agent overrides for the `agent` tool">
        <Text dimColor>No registered sub-agents.</Text>
      </ConfigSection>
    );
  }
  return (
    <ConfigSection
      title="Sub-agent Overrides"
      description="Override model / instructions / tools for each registered sub-agent. Empty values inherit from the SKILL.md defaults."
    >
      <EditableFields tab={ConfigTab.Agents} state={state} />
    </ConfigSection>
  );
}

export function WorktreePanel({ state }: PanelProps): ReactNode {
  const worktreeEnabled = getFieldValue(state.draftConfig, 'worktree.enabled') === 'true';
  return (
    <ConfigSection title="Worktree Isolation" description="Git worktree isolation configuration">
      <FieldRow field={requireFieldByPath('worktree.enabled')} state={state} />
      {worktreeEnabled ? (
        getFieldsForTab(ConfigTab.Worktree)
          .filter((field) => field.path !== 'worktree.enabled')
          .map((field) => <FieldRow key={field.path} field={field} state={state} />)
      ) : (
        <Text dimColor>Enable worktree editing to configure worktree defaults.</Text>
      )}
    </ConfigSection>
  );
}

export const PANEL_COMPONENTS: Record<ConfigTab, (props: PanelProps) => ReactNode> = {
  [ConfigTab.Model]: ModelPanel,
  [ConfigTab.Tools]: ToolsPanel,
  [ConfigTab.Memory]: MemoryPanel,
  [ConfigTab.Runtime]: RuntimePanel,
  [ConfigTab.Worktree]: WorktreePanel,
  [ConfigTab.Agents]: AgentsPanel,
};

//#endregion
