import { Box, Text, useInput, useStdout } from 'ink';
import type { PropsWithChildren, ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import type { SearchModeState } from '../utils/prompt-history-search.js';
import { createSearchModeState, findReverseMatch } from '../utils/prompt-history-search.js';
import {
  appendPromptHistory,
  loadPromptHistory,
  maybeCompactPromptHistory,
} from '../utils/prompt-history-storage.js';
import { ChordSafeTextInput } from './chord-safe-text-input.js';
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
  /**
   * When false, the prompt continues to render (history + cursor visible)
   * but its internal `useInput` stops consuming keystrokes. Used by the
   * Context Split View so the context pane can receive keys while focused.
   * Defaults to true.
   */
  isActive?: boolean;
  /** Show horizontal dividers above and below the input */
  showDividers?: boolean;
  /** Override divider line color (e.g. for focus indicators) */
  dividerColor?: string;
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

interface PromptKeyboardRefs {
  value: React.MutableRefObject<string>;
  suggestions: React.MutableRefObject<Suggestion[]>;
  sugIdx: React.MutableRefObject<number>;
  historyState: React.MutableRefObject<ReturnType<typeof createPromptHistoryState>>;
}

interface PromptKeyboardActions {
  updateValue: (next: string) => void;
  setSug: (next: Suggestion[]) => void;
  setSugI: (next: number) => void;
  setHistoryState: (next: ReturnType<typeof createPromptHistoryState>) => void;
}

interface PromptKeyboardOptions {
  status?: ChatStatus;
  isModalOpen: boolean;
  onModalClose?: () => void;
  onStop?: () => void;
  onToggleMode?: () => void;
  disabled: boolean;
  enableHistory: boolean;
}

function completeSuggestion(refs: PromptKeyboardRefs, actions: PromptKeyboardActions): void {
  const sel = refs.suggestions.current[refs.sugIdx.current];
  if (!sel) {
    return;
  }
  if (refs.value.current.startsWith('/')) {
    actions.updateValue(sel.text);
    actions.setSug([]);
    return;
  }
  const base = refs.value.current.slice(0, refs.value.current.lastIndexOf('@'));
  actions.updateValue(base + sel.text + ' ');
  actions.setSug([]);
}

function handlePromptEscape(
  refs: PromptKeyboardRefs,
  actions: PromptKeyboardActions,
  options: PromptKeyboardOptions,
): void {
  const action = resolvePromptEscapeAction({
    value: refs.value.current,
    status: options.status,
    suggestionCount: refs.suggestions.current.length,
    isModalOpen: options.isModalOpen,
    hasModalClose: options.onModalClose !== undefined,
    hasStop: options.onStop !== undefined,
  });
  if (action === 'close-modal') {
    options.onModalClose?.();
  } else if (action === 'clear-input') {
    actions.updateValue('');
    const nextHistory = resetPromptHistoryNavigation(refs.historyState.current);
    refs.historyState.current = nextHistory;
    actions.setHistoryState(nextHistory);
  } else if (action === 'dismiss-suggestions') {
    actions.setSug([]);
  } else if (action === 'stop') {
    options.onStop?.();
  }
}

interface PromptArrowArgs {
  direction: 'up' | 'down';
  refs: PromptKeyboardRefs;
  actions: PromptKeyboardActions;
  enableHistory: boolean;
}

function handlePromptArrow(args: PromptArrowArgs): void {
  const { direction, refs, actions, enableHistory } = args;
  if (refs.suggestions.current.length > 0) {
    const delta = direction === 'up' ? -1 : 1;
    const next = Math.max(
      0,
      Math.min(refs.suggestions.current.length - 1, refs.sugIdx.current + delta),
    );
    actions.setSugI(next);
    return;
  }
  if (!enableHistory) {
    return;
  }
  if (direction === 'up' && refs.historyState.current.entries.length > 0) {
    const result = navigatePromptHistoryUp(refs.historyState.current, refs.value.current);
    refs.historyState.current = result.state;
    actions.setHistoryState(result.state);
    actions.updateValue(result.value);
  } else if (direction === 'down' && refs.historyState.current.index > 0) {
    const result = navigatePromptHistoryDown(refs.historyState.current);
    refs.historyState.current = result.state;
    actions.setHistoryState(result.state);
    actions.updateValue(result.value);
  }
}

interface PromptSubmitHandlersArgs {
  onSubmit?: (message: PromptInputMessage) => void | Promise<void>;
  attachments: PromptAttachment[];
  usingProvider: boolean;
  controller: PromptInputControllerProps | null;
  isControlled: boolean;
  setLocalValue: (next: string) => void;
  onChange?: (text: string) => void;
  enableHistory: boolean;
  refs: PromptKeyboardRefs;
  actions: PromptKeyboardActions;
}

function usePromptSubmitHandlers(args: PromptSubmitHandlersArgs): {
  handleInputSubmit: (text: string) => void;
} {
  const clearInput = useCallback(() => {
    if (args.usingProvider) {
      args.controller?.textInput.clear();
    } else if (!args.isControlled) {
      args.setLocalValue('');
    }
    args.onChange?.('');
  }, [
    args,
  ]);

  const handleSubmit = useCallback(
    (text: string) => {
      if (!args.onSubmit) {
        return;
      }
      const result = args.onSubmit({
        text,
        attachments: args.attachments,
      });
      if (result instanceof Promise) {
        result.then(
          () => clearInput(),
          () => {
            /* Don't clear on error so user may want to retry */
          },
        );
      } else {
        clearInput();
      }
    },
    [
      args,
      clearInput,
    ],
  );

  const handleInputSubmit = useCallback(
    (text: string) => {
      if (submitSelectedSuggestion(args, handleSubmit)) {
        return;
      }
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      recordHistoryIfEnabled(args, trimmed);
      args.actions.updateValue('');
      handleSubmit(trimmed);
    },
    [
      args,
      handleSubmit,
    ],
  );

  return {
    handleInputSubmit,
  };
}

function submitSelectedSuggestion(
  args: PromptSubmitHandlersArgs,
  handleSubmit: (text: string) => void,
): boolean {
  if (args.refs.suggestions.current.length === 0) {
    return false;
  }
  const sel = args.refs.suggestions.current[args.refs.sugIdx.current];
  if (!sel) {
    return false;
  }
  if (args.refs.value.current.startsWith('/')) {
    args.actions.updateValue('');
    recordHistoryIfEnabled(args, sel.text);
    handleSubmit(sel.text);
    return true;
  }
  const base = args.refs.value.current.slice(0, args.refs.value.current.lastIndexOf('@'));
  args.actions.updateValue(base + sel.text + ' ');
  args.actions.setSug([]);
  return true;
}

function recordHistoryIfEnabled(args: PromptSubmitHandlersArgs, text: string): void {
  if (!args.enableHistory) {
    return;
  }
  const nextHistory = recordPromptHistoryEntry(args.refs.historyState.current, text);
  args.refs.historyState.current = nextHistory;
  args.actions.setHistoryState(nextHistory);
  // Fire-and-forget on the persistence side — see storage module's jsdoc
  // for why errors are swallowed (read-only fs, missing dir, etc.).
  void appendPromptHistory(text);
}

interface SearchModeArgs {
  searchMode: SearchModeState | null;
  setSearchMode: (next: SearchModeState | null) => void;
}

/**
 * Reverse-incremental search keystrokes (Ctrl+R was just pressed or we're
 * already mid-search). All key handling for the prompt is rerouted through
 * here while search mode is active — it returns `true` to indicate the key
 * was consumed and the normal-mode handler should bail.
 */
function handleSearchModeKey(
  input: string,
  key: KeyShape,
  args: PromptKeyboardArgs & SearchModeArgs,
): boolean {
  const current = args.searchMode;
  if (current === null) {
    return false;
  }
  // Esc: cancel; restore the buffer that was active when search began.
  if (key.escape) {
    args.actions.updateValue(current.savedBuffer);
    args.setSearchMode(null);
    return true;
  }
  // Enter: keep the match in the buffer and exit search mode. The Enter
  // keystroke is consumed here so the form's onSubmit is NOT triggered —
  // a second Enter actually submits. This is one step more conservative
  // than bash (which submits on the first Enter) and matches what the
  // user expected during product testing: "review then send."
  if (key.return) {
    args.setSearchMode(null);
    return true;
  }
  const entries = args.refs.historyState.current.entries;
  // Ctrl+R: cycle to the next older match.
  if (key.ctrl && input === 'r') {
    const next = findReverseMatch(entries, current.matchIndex + 1, current.query);
    if (next.index >= 0) {
      args.setSearchMode({
        query: current.query,
        matchIndex: next.index,
        savedBuffer: current.savedBuffer,
      });
      args.actions.updateValue(next.value);
    }
    return true;
  }
  // Backspace: shrink the query and re-search from the top.
  if (key.backspace || key.delete) {
    const nextQuery = current.query.slice(0, -1);
    const next = findReverseMatch(entries, 0, nextQuery);
    args.setSearchMode({
      query: nextQuery,
      matchIndex: next.index,
      savedBuffer: current.savedBuffer,
    });
    args.actions.updateValue(next.index >= 0 ? next.value : current.savedBuffer);
    return true;
  }
  // Typing extends the query. Single printable chars only — Ctrl/meta chords
  // are not query characters.
  if (input.length === 1 && !key.ctrl && !key.meta) {
    const nextQuery = current.query + input;
    const next = findReverseMatch(entries, 0, nextQuery);
    args.setSearchMode({
      query: nextQuery,
      matchIndex: next.index,
      savedBuffer: current.savedBuffer,
    });
    if (next.index >= 0) {
      args.actions.updateValue(next.value);
    }
    return true;
  }
  // Unhandled keys while in search mode are swallowed rather than passed to
  // the normal handler, mirroring bash readline's behaviour.
  return true;
}

interface KeyShape {
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  escape?: boolean;
  return?: boolean;
  tab?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

interface PromptKeyboardArgs {
  focus: boolean;
  disabled: boolean;
  status?: ChatStatus;
  isModalOpen: boolean;
  onModalClose?: () => void;
  onStop?: () => void;
  onToggleMode?: () => void;
  enableHistory: boolean;
  refs: PromptKeyboardRefs;
  actions: PromptKeyboardActions;
}

function usePromptKeyboardHandler(args: PromptKeyboardArgs & SearchModeArgs): void {
  useInput(
    (input, key) => {
      // Search mode short-circuits everything else: Ctrl+R/Enter/Esc/typing
      // all go to handleSearchModeKey while a search is in flight.
      if (handleSearchModeKey(input, key, args)) {
        return;
      }
      // Ctrl+R enters search mode (when history is enabled and there's
      // anything to search through).
      if (
        key.ctrl &&
        input === 'r' &&
        args.enableHistory &&
        args.refs.historyState.current.entries.length > 0
      ) {
        args.setSearchMode(createSearchModeState(args.refs.value.current));
        return;
      }
      if (key.escape) {
        handlePromptEscape(args.refs, args.actions, args);
        return;
      }
      if (key.tab && key.shift && args.onToggleMode) {
        args.onToggleMode();
        return;
      }
      if (args.disabled) {
        return;
      }
      if (key.tab && !key.shift && args.refs.suggestions.current.length > 0) {
        completeSuggestion(args.refs, args.actions);
        return;
      }
      // Shift + arrows are claimed by ChatScroll for line-by-line scrollback.
      // The prompt's history nav must NOT intercept them, or scroll will
      // silently no-op while the prompt cycles through past messages.
      if (key.upArrow && !key.shift) {
        handlePromptArrow({
          direction: 'up',
          refs: args.refs,
          actions: args.actions,
          enableHistory: args.enableHistory,
        });
        return;
      }
      if (key.downArrow && !key.shift) {
        handlePromptArrow({
          direction: 'down',
          refs: args.refs,
          actions: args.actions,
          enableHistory: args.enableHistory,
        });
      }
    },
    {
      isActive: args.focus,
    },
  );
}

// ============================================================================
// Subcomponents
// ============================================================================

/**
 * Horizontal divider line spanning the prompt's available width.
 *
 * Uses Ink's `borderBottom` on an empty Box so the line is drawn by the
 * layout engine itself \u2014 it auto-fits the Box's flex-resolved width and
 * reflows on terminal resize. A previous implementation rendered
 * `'\u2500'.repeat(stdout.columns)` inside a `<Text>`, which overflowed when
 * the prompt lived inside a narrower container (Context Split View dock
 * open) and left a gap when the terminal was widened \u2014 the divider has to
 * follow its container, not the raw terminal column count.
 */
function PromptInputDivider() {
  const { dividerColor, theme } = usePromptInput();
  const color = dividerColor ?? theme.muted;
  return (
    <Box
      width="100%"
      flexShrink={0}
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderColor={color}
      borderDimColor={!dividerColor}
    />
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
      <Text color={promptColor}>{prompt} </Text>
      {isFocused ? (
        <ChordSafeTextInput
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
  isActive = true,
  showDividers = true,
  dividerColor,
  children,
}: PromptInputProps) {
  const theme = useTheme();

  const resolvedPromptColor = promptColor ?? theme.muted;

  // Status-driven state. The input stays focused during 'submitted'/'streaming'
  // so the user can keep typing — submissions made while the agent is working
  // are enqueued on the harness session and delivered as subsequent turns.
  // `disabledProp` still hard-disables (used when a modal is open, etc.).
  const disabled = disabledProp;
  // `isActive` is the pane-level gate (e.g. the context panel has focus, so
  // chat-side input should be inert). It must factor into `isFocused` so the
  // wrapped TextInput stops subscribing to keystrokes and stops swallowing
  // pane-level chords like Ctrl+W as literal characters.
  const isFocused = focus && !disabled && isActive;
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
  // Hydrate from the on-disk history once on mount. The persisted file
  // stores oldest→newest (append order); the in-memory state expects
  // newest at entries[0], so reverse on the way in. Compaction runs the
  // same slow path. Both are fire-and-forget — a missing file or read
  // error must NOT crash the prompt; we fall back to session-only history.
  useEffect(() => {
    if (!enableHistory) {
      return;
    }
    let cancelled = false;
    loadPromptHistory().then((entries) => {
      if (cancelled || entries.length === 0) {
        return;
      }
      const reversed = [
        ...entries,
      ].reverse();
      setHistoryState(createPromptHistoryState(reversed));
    });
    void maybeCompactPromptHistory();
    return (): void => {
      cancelled = true;
    };
  }, [
    enableHistory,
  ]);
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

  const refs = useMemo<PromptKeyboardRefs>(
    () => ({
      value: valueRef,
      suggestions: suggestionsRef,
      sugIdx: sugIdxRef,
      historyState: historyStateRef,
    }),
    [],
  );
  const actions = useMemo<PromptKeyboardActions>(
    () => ({
      updateValue,
      setSug,
      setSugI,
      setHistoryState,
    }),
    [
      updateValue,
      setSug,
      setSugI,
    ],
  );
  const submitArgs = useMemo<PromptSubmitHandlersArgs>(
    () => ({
      onSubmit,
      attachments,
      usingProvider,
      controller,
      isControlled,
      setLocalValue,
      onChange,
      enableHistory,
      refs,
      actions,
    }),
    [
      onSubmit,
      attachments,
      usingProvider,
      controller,
      isControlled,
      onChange,
      enableHistory,
      refs,
      actions,
    ],
  );
  const { handleInputSubmit } = usePromptSubmitHandlers(submitArgs);

  const [searchMode, setSearchMode] = useState<SearchModeState | null>(null);
  // When the prompt loses focus (e.g. context pane focused, or modal opens),
  // abandon any in-flight search. Otherwise the search bar would render
  // for an inactive prompt and confuse the user.
  useEffect(() => {
    if (!(focus && isActive) && searchMode !== null) {
      setSearchMode(null);
    }
  }, [
    focus,
    isActive,
    searchMode,
  ]);

  usePromptKeyboardHandler({
    focus: focus && isActive,
    disabled,
    status,
    isModalOpen,
    onModalClose,
    onStop,
    onToggleMode,
    enableHistory,
    refs,
    actions,
    searchMode,
    setSearchMode,
  });

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
          {searchMode !== null ? <PromptSearchBar state={searchMode} /> : null}
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

/**
 * Single-line status above the prompt while a reverse-incremental search
 * is active. Mirrors bash's `(reverse-i-search)\`q': match`, with one
 * difference: in this app the match also lives in the prompt buffer below,
 * so the search bar focuses on the query itself plus a "no match" hint.
 */
function PromptSearchBar({ state }: { state: SearchModeState }): ReactNode {
  const { theme } = usePromptInput();
  const hasMatch = state.matchIndex >= 0;
  return (
    <Box flexDirection="row">
      <Text dimColor color={theme.muted}>
        (reverse-i-search)
      </Text>
      <Text color={theme.muted}>{' `'}</Text>
      <Text>{state.query}</Text>
      <Text color={theme.muted}>{`': `}</Text>
      {hasMatch ? null : (
        <Text color={theme.error} dimColor>
          no match
        </Text>
      )}
      <Box flexGrow={1} />
      <Text dimColor color={theme.muted}>
        Ctrl+R next · Enter accept · Esc cancel
      </Text>
    </Box>
  );
}

// ── Attach subcomponents ─────────────────────────────────────────────────

PromptInput.Textarea = PromptInputTextarea;
PromptInput.Suggestions = PromptInputSuggestions;
PromptInput.Submit = PromptInputSubmit;
PromptInput.Divider = PromptInputDivider;
PromptInput.StatusText = PromptInputStatusText;
PromptInput.Model = PromptInputModel;
