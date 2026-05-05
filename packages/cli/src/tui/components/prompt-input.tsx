import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import type { PropsWithChildren, ReactNode } from 'react';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { AgentMode } from '../../harness/factory.js';
import type { ChatStatus } from '../chat-status.js';
import type { PromptAttachment } from '../utils/prompt-attachments.js';
import { resolvePromptEscapeAction } from '../utils/prompt-escape.js';
import {
  createPromptHistoryState,
  navigatePromptHistoryDown,
  navigatePromptHistoryUp,
  recordPromptHistoryEntry,
  resetPromptHistoryNavigation,
} from '../utils/prompt-history.js';
import { useTheme } from './theme';

export type { ChatStatus } from '../chat-status.js';

export interface Suggestion {
  text: string;
  desc?: string;
}

/** Message shape passed to onSubmit. */
export interface PromptInputMessage {
  text: string;
  attachments: PromptAttachment[];
}

// ============================================================================
// Provider (lifted state)
// ============================================================================

export interface TextInputContext {
  value: string;
  setValue: (v: string) => void;
  clear: () => void;
}

export interface SuggestionsContext {
  suggestions: Suggestion[];
  selectedIndex: number;
  setSuggestions: (s: Suggestion[]) => void;
  setSelectedIndex: (i: number) => void;
  clear: () => void;
}

interface PromptInputControllerProps {
  textInput: TextInputContext;
  suggestions: SuggestionsContext;
}

const PromptInputControllerCtx = createContext<PromptInputControllerProps | null>(null);

/** Access lifted PromptInput state from outside the component. Requires `<PromptInputProvider>`. */
export function usePromptInputController(): PromptInputControllerProps {
  const ctx = useContext(PromptInputControllerCtx);
  if (!ctx) {
    throw new Error(
      'Wrap your component inside <PromptInputProvider> to use usePromptInputController().',
    );
  }
  return ctx;
}

const useOptionalController = () => useContext(PromptInputControllerCtx);

export type PromptInputProviderProps = PropsWithChildren<{
  initialInput?: string;
}>;

/**
 * Optional provider that lifts PromptInput state outside of PromptInput.
 * Without it, PromptInput stays fully self-managed.
 */
export function PromptInputProvider({ initialInput = '', children }: PromptInputProviderProps) {
  const [value, setValueState] = useState(initialInput);
  const clearInput = useCallback(() => setValueState(''), []);

  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const clearSuggestions = useCallback(() => {
    setSuggestions([]);
    setSelectedIndex(0);
  }, []);

  const controller = useMemo<PromptInputControllerProps>(
    () => ({
      textInput: {
        value,
        setValue: setValueState,
        clear: clearInput,
      },
      suggestions: {
        suggestions,
        selectedIndex,
        setSuggestions,
        setSelectedIndex,
        clear: clearSuggestions,
      },
    }),
    [
      value,
      clearInput,
      suggestions,
      selectedIndex,
      clearSuggestions,
    ],
  );

  return (
    <PromptInputControllerCtx.Provider value={controller}>
      {children}
    </PromptInputControllerCtx.Provider>
  );
}

// ============================================================================
// Component Context (rendering state for subcomponents)
// ============================================================================

export interface PromptInputContextValue {
  value: string;
  isFocused: boolean;
  disabled: boolean;
  status?: ChatStatus;
  onStop?: () => void;
  statusHintText: string;
  placeholder: string;
  prompt: string;
  promptColor: string;
  suggestions: Suggestion[];
  sugIdx: number;
  maxSuggestions: number;
  errorText: string;
  model?: string;
  agentMode?: AgentMode;
  onToggleMode?: () => void;
  dividerColor?: string;
  dividerDashed?: boolean;
  theme: ReturnType<typeof useTheme>;
  handleInput: (value: string) => void;
  handleInputSubmit: (value: string) => void;
}

const PromptInputContext = createContext<PromptInputContextValue | null>(null);

/** Hook for accessing PromptInput state from compound subcomponents. */
export function usePromptInput(): PromptInputContextValue {
  const ctx = useContext(PromptInputContext);
  if (!ctx) {
    throw new Error('usePromptInput must be used within a <PromptInput> component');
  }
  return ctx;
}

// ============================================================================
// Props
// ============================================================================

export interface PromptInputProps {
  /** Controlled input value */
  value?: string;
  /** Default value for uncontrolled mode */
  defaultValue?: string;
  /**
   * Called when user submits a message.
   * Receives `{ text }`. Compatible with Vercel AI SDK's `sendMessage` and
   * easily mapped to any other SDK. If the handler returns a Promise, input
   * is cleared on resolve and preserved on reject so the user can retry.
   */
  onSubmit?: (message: PromptInputMessage) => void | Promise<void>;
  /** Callback when input value changes */
  onChange?: (text: string) => void;
  /** Placeholder text when input is empty */
  placeholder?: string;
  /** Prompt character shown before input */
  prompt?: string;
  /** Color of the prompt character */
  promptColor?: string;
  /**
   * AI chat status — drives disabled state and status indicator.
   * When provided, takes precedence over `disabled`/`disabledText`.
   */
  status?: ChatStatus;
  /** Called when user presses Escape during streaming to stop generation */
  onStop?: () => void;
  /** Called when user presses Escape to close a modal */
  onModalClose?: () => void;
  /** Whether a modal is currently open (changes Escape behavior) */
  isModalOpen?: boolean;
  /** Text shown when status is "submitted" */
  submittedText?: string;
  /** Text shown when status is "streaming" */
  streamingText?: string;
  /** Text shown when status is "error" */
  errorText?: string;
  /** Disable input. Ignored when `status` is provided. */
  disabled?: boolean;
  /** Text shown when disabled. Ignored when `status` is provided. */
  disabledText?: string;
  /** Slash commands for autocomplete */
  commands?: {
    cmd: string;
    desc?: string;
  }[];
  /** File paths for @ mention autocomplete */
  files?: string[];
  /** Custom suggestion provider — overrides commands/files */
  getSuggestions?: (value: string) => Suggestion[];
  /** Max visible suggestions */
  maxSuggestions?: number;
  /** Enable command history with up/down arrows */
  enableHistory?: boolean;
  /** Model name displayed below the input */
  model?: string;
  /** Current agent mode, shown as a colored pill before the model label */
  agentMode?: AgentMode;
  /** Called when the user presses Shift+Tab to cycle the agent mode */
  onToggleMode?: () => void;
  /** Whether the input is focused and accepting keystrokes */
  focus?: boolean;
  /** Show horizontal dividers above and below the input */
  showDividers?: boolean;
  /** Override divider line color (e.g. for focus indicators) */
  dividerColor?: string;
  /** Use dashed divider lines instead of solid */
  dividerDashed?: boolean;
  /** Compound mode: provide subcomponents as children */
  children?: ReactNode;
}

// ============================================================================
// Helpers
// ============================================================================

function computeDefaultSuggestions(
  input: string,
  commands: {
    cmd: string;
    desc?: string;
  }[],
  files: string[],
): Suggestion[] {
  if (input.startsWith('/') && commands.length > 0) {
    return commands
      .filter((c) => c.cmd.startsWith(input))
      .map((c) => ({
        text: c.cmd,
        desc: c.desc,
      }));
  }
  if (input.includes('@') && files.length > 0) {
    const query = input.split('@').pop() ?? '';
    return files
      .filter((f) => f.toLowerCase().includes(query.toLowerCase()))
      .map((f) => ({
        text: '@' + f,
      }));
  }
  return [];
}

interface StatusHintTextOptions {
  status: ChatStatus | undefined;
  submittedText: string;
  streamingText: string;
  errorText: string;
  disabledText: string;
}

function resolveStatusHintText(options: StatusHintTextOptions): string {
  if (options.status === 'submitted') {
    return options.submittedText;
  }
  if (options.status === 'streaming') {
    return options.streamingText;
  }
  if (options.status === 'error') {
    return options.errorText;
  }
  return options.disabledText;
}

// ============================================================================
// Subcomponents
// ============================================================================

/** Horizontal divider line fills the full terminal width. */
function PromptInputDivider() {
  const { dividerColor, dividerDashed, theme } = usePromptInput();
  const { stdout } = useStdout();
  // Ink's useStdout provides the terminal dimensions
  const width = stdout?.columns ?? 80;
  const color = dividerColor ?? theme.muted;
  const char = dividerDashed ? '\u254C' : '\u2500';
  const line = char.repeat(width);
  return (
    <Box width="100%">
      <Text color={color} dimColor={!dividerColor}>
        {line}
      </Text>
    </Box>
  );
}

/** Autocomplete suggestion list - appears below input like Claude Code. */
function PromptInputSuggestions() {
  const { suggestions, sugIdx, maxSuggestions, theme } = usePromptInput();
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const visible = suggestions.slice(0, maxSuggestions);
  if (visible.length === 0) {
    return null;
  }
  // Calculate column width for command names (longest command + padding)
  const maxCmdLen = Math.max(...visible.map((s) => s.text.length));
  const cmdColWidth = Math.min(maxCmdLen + 4, 32);

  return (
    <Box flexDirection="column">
      {visible.map((sug, i) => {
        const active = i === sugIdx;
        // Pad command name to fixed width for aligned descriptions
        const paddedCmd = sug.text.padEnd(cmdColWidth);
        // Truncate description to fit remaining width
        const descMaxLen = width - cmdColWidth - 2;
        const desc = sug.desc
          ? sug.desc.length > descMaxLen
            ? sug.desc.slice(0, descMaxLen - 1) + '\u2026'
            : sug.desc
          : '';

        return (
          <Text key={sug.text}>
            <Text color={active ? theme.primary : theme.muted}>{paddedCmd}</Text>
            <Text dimColor color={theme.placeholder}>
              {desc}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}

/** Prompt char + input element when focused, static text otherwise. */
function PromptInputTextarea() {
  const {
    value,
    isFocused,
    disabled,
    statusHintText,
    placeholder,
    prompt,
    promptColor,
    theme,
    handleInput,
    handleInputSubmit,
  } = usePromptInput();
  return (
    <Box flexDirection="row">
      <Text color={promptColor}>{prompt}</Text>
      {isFocused ? (
        <TextInput
          value={value}
          placeholder={placeholder}
          onChange={handleInput}
          onSubmit={handleInputSubmit}
        />
      ) : disabled && value.length === 0 ? (
        <Text dimColor color={theme.placeholder}>
          {statusHintText}
        </Text>
      ) : (
        <Text color={value ? theme.foreground : theme.placeholder} dimColor={!value}>
          {value || placeholder}
        </Text>
      )}
    </Box>
  );
}

/**
 * Status indicator: Enter ready, Half-circle submitted, Square streaming, X error.
 * When `status` and `onStop` are provided via context, the streaming icon
 * doubles as a stop button (Escape triggers onStop).
 */
function PromptInputSubmit(props: { status?: ChatStatus; onStop?: () => void }) {
  const ctx = usePromptInput();
  const status = props.status ?? ctx.status;
  const { disabled, theme } = ctx;

  const isGenerating = status === 'submitted' || status === 'streaming';

  const icon =
    status === 'submitted'
      ? '\u25D0'
      : status === 'streaming'
        ? (props.onStop ?? ctx.onStop)
          ? '\u25A0'
          : '\u25D0'
        : status === 'error'
          ? '\u2715'
          : '\u23CE';

  const color =
    status === 'error'
      ? theme.error
      : isGenerating
        ? theme.muted
        : disabled
          ? theme.muted
          : theme.primary;

  return <Text color={color}>{' ' + icon}</Text>;
}

/** Error/hint text below input. */
function PromptInputStatusText() {
  const { status, errorText, theme } = usePromptInput();
  if (status !== 'error') {
    return null;
  }
  return <Text color={theme.error}>{errorText}</Text>;
}

/** Mode pill + model label shown below the input. */
function PromptInputModel() {
  const { model, agentMode, theme } = usePromptInput();
  if (!model && !agentMode) {
    return null;
  }
  const isPlan = agentMode === 'planning';
  const modeColor = isPlan ? theme.warning : theme.success;
  const modeLabel = isPlan ? 'PLAN' : 'ACT';
  return (
    <Box flexDirection="row">
      {agentMode ? (
        <Box marginRight={1}>
          <Text bold color={modeColor}>
            {modeLabel}
          </Text>
        </Box>
      ) : null}
      {model ? (
        <Text dimColor color={theme.muted}>
          {model}
        </Text>
      ) : null}
    </Box>
  );
}

// ============================================================================
// Root component
// ============================================================================

export function PromptInput({
  value: controlledValue,
  defaultValue = '',
  onSubmit,
  onChange,
  placeholder = 'Type a message...',
  prompt = '\u276F',
  promptColor,
  status,
  onStop,
  onModalClose,
  isModalOpen = false,
  submittedText = 'Thinking...',
  streamingText: streamingLabel = 'Generating...',
  errorText = 'An error occurred. Try again.',
  disabled: disabledProp = false,
  disabledText = 'Generating...',
  commands = [],
  files = [],
  getSuggestions: customGetSuggestions,
  maxSuggestions = 5,
  enableHistory = true,
  model,
  agentMode,
  onToggleMode,
  focus = true,
  showDividers = true,
  dividerColor,
  dividerDashed,
  children,
}: PromptInputProps) {
  const theme = useTheme();

  const resolvedPromptColor = promptColor ?? theme.muted;

  // Status-driven state. The input stays focused during 'submitted'/'streaming'
  // so the user can keep typing — submissions made while the agent is working
  // are enqueued on the harness session and delivered as subsequent turns.
  // `disabledProp` still hard-disables (used when a modal is open, etc.).
  const disabled = disabledProp;
  const isFocused = focus && !disabled;
  const statusHintText = resolveStatusHintText({
    status,
    submittedText,
    streamingText: streamingLabel,
    errorText,
    disabledText,
  });

  // ── Dual-mode state: provider-managed or self-managed ──────────────────
  const controller = useOptionalController();
  const usingProvider = !!controller;

  const isControlled = controlledValue !== undefined;
  const controlledRef = useRef(isControlled);
  if (controlledRef.current !== isControlled) {
    console.warn('PromptInput: switching between controlled and uncontrolled is not supported.');
  }

  // Local state (used when no provider and not controlled)
  const [localValue, setLocalValue] = useState(defaultValue);
  const [localSuggestions, setLocalSuggestions] = useState<Suggestion[]>([]);
  const [localSugIdx, setLocalSugIdx] = useState(0);
  const [historyState, setHistoryState] = useState(() => createPromptHistoryState([]));
  const [attachments] = useState<PromptAttachment[]>([]);

  // Resolve value from: controlled prop > provider > local
  const value = isControlled
    ? controlledValue
    : usingProvider
      ? controller.textInput.value
      : localValue;

  const suggestions = usingProvider ? controller.suggestions.suggestions : localSuggestions;
  const sugIdx = usingProvider ? controller.suggestions.selectedIndex : localSugIdx;

  // ── State updaters (unified across modes) ──────────────────────────────

  const valueRef = useRef(defaultValue);
  if (isControlled) {
    valueRef.current = controlledValue;
  } else if (usingProvider) {
    valueRef.current = controller.textInput.value;
  } else {
    valueRef.current = localValue;
  }

  const suggestionsRef = useRef<Suggestion[]>([]);
  suggestionsRef.current = suggestions;
  const sugIdxRef = useRef(0);
  sugIdxRef.current = sugIdx;
  const historyStateRef = useRef(historyState);
  historyStateRef.current = historyState;

  const setSug = useCallback(
    (next: Suggestion[]) => {
      suggestionsRef.current = next;
      if (usingProvider) {
        controller.suggestions.setSuggestions(next);
      } else {
        setLocalSuggestions(next);
      }
    },
    [
      usingProvider,
      controller,
    ],
  );

  const setSugI = useCallback(
    (next: number) => {
      sugIdxRef.current = next;
      if (usingProvider) {
        controller.suggestions.setSelectedIndex(next);
      } else {
        setLocalSugIdx(next);
      }
    },
    [
      usingProvider,
      controller,
    ],
  );

  const computeSuggestions = useCallback(
    (input: string): Suggestion[] => {
      if (customGetSuggestions) {
        return customGetSuggestions(input);
      }
      return computeDefaultSuggestions(input, commands, files);
    },
    [
      customGetSuggestions,
      commands,
      files,
    ],
  );

  const updateValue = useCallback(
    (next: string) => {
      valueRef.current = next;
      if (isControlled) {
        // controlled: only fire onChange, parent owns state
      } else if (usingProvider) {
        controller.textInput.setValue(next);
      } else {
        setLocalValue(next);
      }
      onChange?.(next);
      const sug = computeSuggestions(next);
      setSug(sug);
      setSugI(0);
    },
    [
      isControlled,
      usingProvider,
      controller,
      onChange,
      computeSuggestions,
      setSug,
      setSugI,
    ],
  );

  // ── Submit handler (auto-clears on success, preserves on error) ────────

  const clearInput = useCallback(() => {
    if (usingProvider) {
      controller.textInput.clear();
    } else if (!isControlled) {
      setLocalValue('');
    }
    onChange?.('');
  }, [
    usingProvider,
    controller,
    isControlled,
    onChange,
  ]);

  const handleSubmit = useCallback(
    (text: string) => {
      if (!onSubmit) {
        return;
      }

      const result = onSubmit({
        text,
        attachments,
      });

      // Handle async onSubmit: clear on resolve, preserve on reject
      if (result instanceof Promise) {
        result.then(
          () => clearInput(),
          () => {
            /* Don't clear on error so user may want to retry */
          },
        );
      } else {
        // Sync onSubmit completed without throwing, clear
        clearInput();
      }
    },
    [
      onSubmit,
      clearInput,
      attachments,
    ],
  );

  // ── Input handlers ───────────────────────────────────────────────────

  const handleInputSubmit = useCallback(
    (text: string) => {
      // If there are suggestions and one is selected, handle that
      if (suggestionsRef.current.length > 0) {
        const sel = suggestionsRef.current[sugIdxRef.current];
        if (sel) {
          if (valueRef.current.startsWith('/')) {
            // Slash commands: submit immediately on selection
            updateValue('');
            if (enableHistory) {
              const nextHistory = recordPromptHistoryEntry(historyStateRef.current, sel.text);
              historyStateRef.current = nextHistory;
              setHistoryState(nextHistory);
            }
            handleSubmit(sel.text);
          } else {
            const base = valueRef.current.slice(0, valueRef.current.lastIndexOf('@'));
            updateValue(base + sel.text + ' ');
            setSug([]);
          }
          return;
        }
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      if (enableHistory) {
        const nextHistory = recordPromptHistoryEntry(historyStateRef.current, trimmed);
        historyStateRef.current = nextHistory;
        setHistoryState(nextHistory);
      }
      updateValue('');
      handleSubmit(trimmed);
    },
    [
      enableHistory,
      handleSubmit,
      setSug,
      updateValue,
    ],
  );

  // ── Keyboard handler via useInput ───────────────────────────────────
  // Always active when focused OR when we need to handle Escape for stopping
  const isKeyboardActive = focus;

  useInput(
    (_input, key) => {
      if (key.escape) {
        const action = resolvePromptEscapeAction({
          value: valueRef.current,
          status,
          suggestionCount: suggestionsRef.current.length,
          isModalOpen,
          hasModalClose: onModalClose !== undefined,
          hasStop: onStop !== undefined,
        });
        if (action === 'close-modal') {
          onModalClose?.();
          return;
        }
        if (action === 'clear-input') {
          updateValue('');
          const nextHistory = resetPromptHistoryNavigation(historyStateRef.current);
          historyStateRef.current = nextHistory;
          setHistoryState(nextHistory);
          return;
        }
        if (action === 'dismiss-suggestions') {
          setSug([]);
          return;
        }
        if (action === 'stop') {
          onStop?.();
        }
        return;
      }

      // works even while disabled, e.g. mid-stream
      if (key.tab && key.shift && onToggleMode) {
        onToggleMode();
        return;
      }

      // When disabled, ignore all other keys
      if (disabled) {
        return;
      }

      // Tab: auto-complete current suggestion
      if (key.tab && !key.shift && suggestionsRef.current.length > 0) {
        const sel = suggestionsRef.current[sugIdxRef.current];
        if (sel) {
          if (valueRef.current.startsWith('/')) {
            // For slash commands, complete with the full command
            updateValue(sel.text);
            setSug([]);
          } else {
            // For @ mentions, complete after the @ symbol
            const base = valueRef.current.slice(0, valueRef.current.lastIndexOf('@'));
            updateValue(base + sel.text + ' ');
            setSug([]);
          }
        }
        return;
      }

      // Up arrow: navigate suggestions or history
      if (key.upArrow) {
        if (suggestionsRef.current.length > 0) {
          setSugI(Math.max(0, sugIdxRef.current - 1));
        } else if (enableHistory && historyStateRef.current.entries.length > 0) {
          const result = navigatePromptHistoryUp(historyStateRef.current, valueRef.current);
          historyStateRef.current = result.state;
          setHistoryState(result.state);
          updateValue(result.value);
        }
        return;
      }

      // Down arrow: navigate suggestions or history
      if (key.downArrow) {
        if (suggestionsRef.current.length > 0) {
          setSugI(Math.min(suggestionsRef.current.length - 1, sugIdxRef.current + 1));
        } else if (enableHistory && historyStateRef.current.index > 0) {
          const result = navigatePromptHistoryDown(historyStateRef.current);
          historyStateRef.current = result.state;
          setHistoryState(result.state);
          updateValue(result.value);
        }
        return;
      }
    },
    {
      isActive: isKeyboardActive,
    },
  );

  // ── Build context for subcomponents ────────────────────────────────────

  const visibleSuggestions = useMemo(
    () => suggestions.slice(0, maxSuggestions),
    [
      suggestions,
      maxSuggestions,
    ],
  );

  const ctxValue: PromptInputContextValue = useMemo(
    () => ({
      value,
      isFocused,
      disabled,
      status,
      onStop,
      statusHintText,
      placeholder,
      prompt,
      promptColor: resolvedPromptColor,
      suggestions: visibleSuggestions,
      sugIdx,
      maxSuggestions,
      errorText,
      model,
      agentMode,
      onToggleMode,
      dividerColor,
      dividerDashed,
      theme,
      handleInput: updateValue,
      handleInputSubmit,
    }),
    [
      value,
      isFocused,
      disabled,
      status,
      onStop,
      statusHintText,
      placeholder,
      prompt,
      resolvedPromptColor,
      visibleSuggestions,
      sugIdx,
      maxSuggestions,
      errorText,
      model,
      agentMode,
      onToggleMode,
      dividerColor,
      dividerDashed,
      theme,
      updateValue,
      handleInputSubmit,
    ],
  );

  // ── Render ─────────────────────────────────────────────────────────────

  if (children) {
    return (
      <PromptInputContext.Provider value={ctxValue}>
        <Box flexDirection="column" flexShrink={0}>
          {children}
        </Box>
      </PromptInputContext.Provider>
    );
  }

  return (
    <PromptInputContext.Provider value={ctxValue}>
      <Box flexDirection="column" flexShrink={0}>
        {showDividers && <PromptInputDivider />}
        <Box flexDirection="column" paddingX={1}>
          <PromptInputTextarea />
          <PromptInputStatusText />
          <PromptInputModel />
        </Box>
        {showDividers && <PromptInputDivider />}
        <PromptInputSuggestions />
      </Box>
    </PromptInputContext.Provider>
  );
}

// ── Attach subcomponents ─────────────────────────────────────────────────

PromptInput.Textarea = PromptInputTextarea;
PromptInput.Suggestions = PromptInputSuggestions;
PromptInput.Submit = PromptInputSubmit;
PromptInput.Divider = PromptInputDivider;
PromptInput.StatusText = PromptInputStatusText;
PromptInput.Model = PromptInputModel;
