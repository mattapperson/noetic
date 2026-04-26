import type { AgentConfig } from '../../../types/config.js';
import { getFieldValue, setFieldValue } from './accessors.js';
import { getFirstFieldForTab, getNextField } from './fields.js';
import type { ConfigEditorState, ConfigFieldPath } from './types.js';
import { ConfigTab, EditorMode } from './types.js';
import { validateConfig, validateField } from './validation.js';

//#region Init

export function createInitialState(config: AgentConfig, initialTab: ConfigTab): ConfigEditorState {
  const focusedField = getFirstFieldForTab(initialTab);
  return {
    originalConfig: config,
    draftConfig: config,
    selectedTab: initialTab,
    focusedField,
    mode: EditorMode.Navigate,
    editValue: '',
    dirtyFields: new Set(),
    validationErrors: new Map(),
    saveConfirmed: false,
  };
}

//#endregion

//#region Navigation

export function selectTab(state: ConfigEditorState, tab: string): ConfigEditorState {
  const selectedTab = isConfigTab(tab) ? tab : ConfigTab.Model;
  return {
    ...state,
    selectedTab,
    focusedField: getFirstFieldForTab(selectedTab),
    globalError: undefined,
  };
}

export function focusNextField(
  state: ConfigEditorState,
  offset: number,
  isFieldVisible: (path: ConfigFieldPath) => boolean,
): ConfigEditorState {
  return {
    ...state,
    focusedField: getNextField(state.focusedField, offset, isFieldVisible),
    globalError: undefined,
  };
}

function isConfigTab(value: string): value is ConfigTab {
  return CONFIG_TAB_VALUES.includes(value);
}

const CONFIG_TAB_VALUES: ReadonlyArray<string> = Object.values(ConfigTab);

//#endregion

//#region Editing

export function startEditing(state: ConfigEditorState): ConfigEditorState {
  return {
    ...state,
    mode: EditorMode.Edit,
    editValue: getFieldValue(state.draftConfig, state.focusedField),
    globalError: undefined,
    globalMessage: undefined,
  };
}

export function updateEditValue(state: ConfigEditorState, value: string): ConfigEditorState {
  return {
    ...state,
    editValue: value,
  };
}

export function cancelEditing(state: ConfigEditorState): ConfigEditorState {
  return {
    ...state,
    mode: EditorMode.Navigate,
    editValue: '',
    globalError: undefined,
  };
}

export function commitEdit(state: ConfigEditorState): ConfigEditorState {
  const error = validateField(state.focusedField, state.editValue);
  if (error) {
    return withFieldError(state, state.focusedField, error);
  }

  const draftConfig = setFieldValue(state.draftConfig, state.focusedField, state.editValue);
  const dirtyFields = updateDirtyFields(
    state.dirtyFields,
    state.focusedField,
    getFieldValue(state.originalConfig, state.focusedField) !==
      getFieldValue(draftConfig, state.focusedField),
  );
  const validationErrors = new Map(state.validationErrors);
  validationErrors.delete(state.focusedField);

  return {
    ...state,
    draftConfig,
    dirtyFields,
    validationErrors,
    mode: EditorMode.Navigate,
    editValue: '',
    globalError: undefined,
    globalMessage: undefined,
  };
}

export function toggleFocusedBoolean(state: ConfigEditorState): ConfigEditorState {
  const current = getFieldValue(state.draftConfig, state.focusedField);
  const nextValue = current === 'true' ? 'false' : 'true';
  return commitEdit({
    ...state,
    editValue: nextValue,
  });
}

export function cycleFocusedSelect(
  state: ConfigEditorState,
  options: ReadonlyArray<string>,
): ConfigEditorState {
  const current = getFieldValue(state.draftConfig, state.focusedField);
  const currentIndex = options.indexOf(current);
  const nextIndex = (currentIndex + 1) % options.length;
  return commitEdit({
    ...state,
    editValue: options[nextIndex] ?? current,
  });
}

function withFieldError(
  state: ConfigEditorState,
  path: ConfigFieldPath,
  error: string,
): ConfigEditorState {
  const validationErrors = new Map(state.validationErrors);
  validationErrors.set(path, error);
  return {
    ...state,
    validationErrors,
    globalError: error,
  };
}

function updateDirtyFields(
  current: ReadonlySet<ConfigFieldPath>,
  path: ConfigFieldPath,
  isDirty: boolean,
): ReadonlySet<ConfigFieldPath> {
  const next = new Set(current);
  if (isDirty) {
    next.add(path);
    return next;
  }
  next.delete(path);
  return next;
}

//#endregion

//#region Reset and Save State

export function resetFocusedField(state: ConfigEditorState): ConfigEditorState {
  const rawValue = getFieldValue(state.originalConfig, state.focusedField);
  const draftConfig = setFieldValue(state.draftConfig, state.focusedField, rawValue);
  const dirtyFields = updateDirtyFields(state.dirtyFields, state.focusedField, false);
  const validationErrors = new Map(state.validationErrors);
  validationErrors.delete(state.focusedField);
  return {
    ...state,
    draftConfig,
    dirtyFields,
    validationErrors,
    globalError: undefined,
    globalMessage: 'Field reset',
  };
}

export function resetAllFields(state: ConfigEditorState): ConfigEditorState {
  return {
    ...state,
    draftConfig: state.originalConfig,
    dirtyFields: new Set(),
    validationErrors: new Map(),
    globalError: undefined,
    globalMessage: 'All changes reset',
    mode: EditorMode.Navigate,
  };
}

export function prepareSave(state: ConfigEditorState): ConfigEditorState {
  const validationErrors = validateConfig(state.draftConfig);
  if (validationErrors.size === 0) {
    return {
      ...state,
      validationErrors,
      mode: EditorMode.Saving,
      globalError: undefined,
      globalMessage: undefined,
    };
  }
  return {
    ...state,
    validationErrors,
    globalError: 'Fix validation errors before saving',
  };
}

export function markSaved(state: ConfigEditorState): ConfigEditorState {
  return {
    ...state,
    originalConfig: state.draftConfig,
    dirtyFields: new Set(),
    validationErrors: new Map(),
    mode: EditorMode.Navigate,
    globalError: undefined,
    globalMessage: 'Saved. Restart Noetic for all changes to take effect.',
    saveConfirmed: true,
  };
}

export function markSaveFailed(state: ConfigEditorState, error: string): ConfigEditorState {
  return {
    ...state,
    mode: EditorMode.Navigate,
    globalError: error,
  };
}

//#endregion
