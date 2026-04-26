import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { Tab, Tabs } from '../../../tui/components/tabs/index.js';
import { useTheme } from '../../../tui/components/theme.js';
import { CONFIG_FIELDS_BY_PATH } from './fields.js';
import { PANEL_COMPONENTS } from './panels.js';
import { saveConfig } from './save.js';
import {
  commitEdit,
  createInitialState,
  cycleFocusedSelect,
  focusNextField,
  markSaved,
  markSaveFailed,
  prepareSave,
  resetAllFields,
  resetFocusedField,
  selectTab,
  startEditing,
  toggleFocusedBoolean,
  updateEditValue,
} from './state.js';
import type { ConfigEditorProps, ConfigEditorState, ConfigFieldPath } from './types.js';
import { CONFIG_TAB_ORDER, CONFIG_TAB_TITLES, EditorMode, FieldKind } from './types.js';

//#region Helpers

function buildCloseMessage(sourcePath: string | undefined): string {
  if (!sourcePath) {
    return 'Configuration editor closed';
  }
  return `Configuration saved to ${sourcePath}`;
}

function getModeLabel(state: ConfigEditorState): string {
  if (state.validationErrors.size > 0) {
    return 'Invalid';
  }
  return state.mode;
}

function isFieldVisibleForState(state: ConfigEditorState, path: ConfigFieldPath): boolean {
  if (!path.startsWith('worktree.') || path === 'worktree.enabled') {
    return true;
  }
  return state.draftConfig.worktree !== undefined;
}

//#endregion

//#region Components

function StatusBar({
  state,
  sourcePath,
}: {
  state: ConfigEditorState;
  sourcePath?: string;
}): ReactNode {
  const theme = useTheme();
  const dirtyText = state.dirtyFields.size > 0 ? 'Unsaved changes' : 'No changes';
  const pathText = sourcePath ?? './noetic.config.ts (new)';
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>Config: {pathText}</Text>
      <Text>
        <Text color={theme.accent}>Mode: {getModeLabel(state)}</Text>
        <Text dimColor> • </Text>
        <Text color={state.dirtyFields.size > 0 ? theme.warning : theme.success}>{dirtyText}</Text>
      </Text>
      {state.globalError && <Text color={theme.error}>{state.globalError}</Text>}
      {state.globalMessage && <Text color={theme.success}>{state.globalMessage}</Text>}
    </Box>
  );
}

function HelpBar({ state }: { state: ConfigEditorState }): ReactNode {
  if (state.mode === EditorMode.Edit) {
    return <Text dimColor>Enter: commit • Esc: cancel edit</Text>;
  }
  if (state.mode === EditorMode.ConfirmClose) {
    return <Text dimColor>s: save and close • d: discard • Esc: keep editing</Text>;
  }
  if (state.mode === EditorMode.ConfirmCreate) {
    return <Text dimColor>Enter: create config • Esc: cancel</Text>;
  }
  if (state.mode === EditorMode.ConfirmRewrite) {
    return <Text dimColor>Enter: confirm rewrite/save • Esc: cancel</Text>;
  }
  return (
    <Text dimColor>
      ↑/↓: fields • Enter: edit/toggle • Tab: tabs • s: save • r: reset field • R: reset all • Esc:
      close
    </Text>
  );
}

function EditInput({
  state,
  onChange,
  onSubmit,
}: {
  state: ConfigEditorState;
  onChange: (value: string) => void;
  onSubmit: () => void;
}): ReactNode {
  const field = CONFIG_FIELDS_BY_PATH[state.focusedField];
  const mask = field.kind === FieldKind.MaskedText ? '•' : undefined;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Editing {field.label}</Text>
      <Box borderStyle="single" paddingX={1}>
        <TextInput value={state.editValue} mask={mask} onChange={onChange} onSubmit={onSubmit} />
      </Box>
    </Box>
  );
}

function ConfirmClose(): ReactNode {
  const theme = useTheme();
  return (
    <Box
      borderStyle="round"
      borderColor={theme.warning}
      paddingX={1}
      marginTop={1}
      flexDirection="column"
    >
      <Text color={theme.warning} bold>
        Unsaved changes
      </Text>
      <Text>Save before closing?</Text>
      <Text dimColor>s: save and close • d: discard • Esc: keep editing</Text>
    </Box>
  );
}

function ConfirmRewrite({ sourcePath }: { sourcePath?: string }): ReactNode {
  const theme = useTheme();
  return (
    <Box
      borderStyle="round"
      borderColor={theme.warning}
      paddingX={1}
      marginTop={1}
      flexDirection="column"
    >
      <Text color={theme.warning} bold>
        Confirm save
      </Text>
      <Text>
        Saving will rewrite {sourcePath ?? './noetic.config.ts'} using Noetic's standard format.
      </Text>
      <Text dimColor>Enter: continue • Esc: cancel</Text>
    </Box>
  );
}

function ConfirmCreate(): ReactNode {
  const theme = useTheme();
  return (
    <Box
      borderStyle="round"
      borderColor={theme.warning}
      paddingX={1}
      marginTop={1}
      flexDirection="column"
    >
      <Text color={theme.warning} bold>
        Create config file
      </Text>
      <Text>No config file was found. Create ./noetic.config.ts?</Text>
      <Text dimColor>Enter: create • Esc: cancel</Text>
    </Box>
  );
}

//#endregion

//#region Editor

export function ConfigEditor({
  initialTab,
  config,
  sourcePath,
  onCancel,
}: ConfigEditorProps): ReactNode {
  const theme = useTheme();
  const [state, setState] = useState(() => createInitialState(config, initialTab));
  const [closeAfterSave, setCloseAfterSave] = useState(false);

  useEffect(() => {
    if (state.mode !== EditorMode.Saving) {
      return;
    }
    let mounted = true;
    const run = async (): Promise<void> => {
      try {
        const result = await saveConfig({
          config: state.draftConfig,
          editedFields: state.dirtyFields,
          sourcePath,
        });
        if (!mounted) {
          return;
        }
        setState((current) => markSaved(current));
        if (closeAfterSave) {
          onCancel(buildCloseMessage(result.sourcePath));
        }
      } catch (error) {
        if (!mounted) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setState((current) => markSaveFailed(current, message));
        setCloseAfterSave(false);
      }
    };
    void run();
    return () => {
      mounted = false;
    };
  }, [
    state.mode,
    state.draftConfig,
    sourcePath,
    closeAfterSave,
    onCancel,
    state.dirtyFields,
  ]);

  const requestSave = (shouldClose: boolean): void => {
    if (state.saveConfirmed) {
      setCloseAfterSave(shouldClose);
      setState((current) => prepareSave(current));
      return;
    }
    setCloseAfterSave(shouldClose);
    setState((current) => ({
      ...current,
      mode: sourcePath ? EditorMode.ConfirmRewrite : EditorMode.ConfirmCreate,
    }));
  };

  useInput(
    (input, key) => {
      if (state.mode === EditorMode.Saving) {
        return;
      }
      if (state.mode === EditorMode.Edit) {
        if (key.escape) {
          setState((current) => ({
            ...current,
            mode: EditorMode.Navigate,
            editValue: '',
            globalError: undefined,
          }));
        }
        return;
      }
      if (state.mode === EditorMode.ConfirmClose) {
        if (input === 's') {
          requestSave(true);
          return;
        }
        if (input === 'd') {
          onCancel('Configuration changes discarded');
          return;
        }
        if (key.escape) {
          setState((current) => ({
            ...current,
            mode: EditorMode.Navigate,
          }));
        }
        return;
      }
      if (state.mode === EditorMode.ConfirmRewrite || state.mode === EditorMode.ConfirmCreate) {
        if (key.return) {
          setState((current) =>
            prepareSave({
              ...current,
              saveConfirmed: true,
            }),
          );
          return;
        }
        if (key.escape) {
          setCloseAfterSave(false);
          setState((current) => ({
            ...current,
            mode: EditorMode.Navigate,
          }));
        }
        return;
      }
      if (key.escape) {
        if (state.dirtyFields.size === 0) {
          onCancel('Configuration editor closed');
          return;
        }
        setState((current) => ({
          ...current,
          mode: EditorMode.ConfirmClose,
        }));
        return;
      }
      if (key.upArrow) {
        setState((current) =>
          focusNextField(current, -1, (path) => isFieldVisibleForState(current, path)),
        );
        return;
      }
      if (key.downArrow) {
        setState((current) =>
          focusNextField(current, 1, (path) => isFieldVisibleForState(current, path)),
        );
        return;
      }
      if (input === 's') {
        requestSave(false);
        return;
      }
      if (input === 'r') {
        setState((current) => resetFocusedField(current));
        return;
      }
      if (input === 'R') {
        setState((current) => resetAllFields(current));
        return;
      }
      if (key.return) {
        const field = CONFIG_FIELDS_BY_PATH[state.focusedField];
        if (field.kind === FieldKind.Boolean) {
          setState((current) => toggleFocusedBoolean(current));
          return;
        }
        if (field.kind === FieldKind.Select && field.options) {
          setState((current) => cycleFocusedSelect(current, field.options ?? []));
          return;
        }
        setState((current) => startEditing(current));
      }
    },
    {
      isActive: true,
    },
  );

  return (
    <Box flexDirection="column" width="100%" padding={1}>
      <Text bold color={theme.accent}>
        Agent Configuration
      </Text>
      <Tabs
        selectedTab={state.selectedTab}
        onTabChange={(tab) => setState((current) => selectTab(current, tab))}
        color={theme.accent}
        disableNavigation={state.mode !== EditorMode.Navigate}
      >
        {CONFIG_TAB_ORDER.map((id) => {
          const Panel = PANEL_COMPONENTS[id];
          return (
            <Tab key={id} id={id} title={CONFIG_TAB_TITLES[id]}>
              <Panel state={state} />
            </Tab>
          );
        })}
      </Tabs>
      {state.mode === EditorMode.Edit && (
        <EditInput
          state={state}
          onChange={(value) => setState((current) => updateEditValue(current, value))}
          onSubmit={() => setState((current) => commitEdit(current))}
        />
      )}
      {state.mode === EditorMode.ConfirmClose && <ConfirmClose />}
      {state.mode === EditorMode.ConfirmCreate && <ConfirmCreate />}
      {state.mode === EditorMode.ConfirmRewrite && <ConfirmRewrite sourcePath={sourcePath} />}
      <StatusBar state={state} sourcePath={sourcePath} />
      <HelpBar state={state} />
    </Box>
  );
}

//#endregion
