import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';
import type { Step } from './chain-of-thought';
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from './chain-of-thought';
import type { Theme } from './theme';
import { useTheme } from './theme';

export type { Step } from './chain-of-thought';

// ── Constants ──────────────────────────────────────────────────────

const MAX_RESULT_PREVIEW_CHARS = 120;

// ── Part types (optional helpers — not coupled to sub-components) ──

export type TextPart = {
  type: 'text';
  text: string;
};

export type ReasoningPart = {
  type: 'reasoning';
  text?: string;
  duration?: string;
  steps?: Step[];
  collapsed?: boolean;
};

export type ToolCallState = 'pending' | 'running' | 'completed' | 'error';

export type ToolCallPart = {
  type: 'tool-call';
  name: string;
  state: ToolCallState;
  args?: unknown;
  result?: unknown;
};

export type SourcePart = {
  type: 'source';
  title?: string;
  url?: string;
};

export type MessagePart = TextPart | ReasoningPart | ToolCallPart | SourcePart;

// ── Role ────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system';

// ── Context ─────────────────────────────────────────────────────────

export interface MessageContextValue {
  role: MessageRole;
  isStreaming: boolean;
  streamingCursor: string;
  backgroundColor: string;
  textColor: string;
}

const MessageContext = createContext<MessageContextValue | null>(null);

export function useMessage(): MessageContextValue {
  const ctx = useContext(MessageContext);
  if (!ctx) {
    throw new Error('useMessage must be used within <Message>');
  }
  return ctx;
}

// ── Style helpers ───────────────────────────────────────────────────

function getBubbleColors(theme: Theme): {
  assistantBg: string;
  userBg: string;
} {
  const isDark = theme.isDark;
  return isDark
    ? {
        assistantBg: '#2a2a4a',
        userBg: '#2a3a3a',
      }
    : {
        assistantBg: '#F1F5F9',
        userBg: '#E2E8F0',
      };
}

const TOOL_STATE_ICONS: Record<ToolCallState, string> = {
  pending: '\u2022', // •
  running: '\u280B', // ⠋
  completed: '\u2713', // ✓
  error: '\u2715', // ✕
};

function getToolStateColor(state: ToolCallState, theme: Theme): string {
  switch (state) {
    case 'pending':
      return theme.muted;
    case 'running':
      return theme.warning;
    case 'completed':
      return theme.success;
    case 'error':
      return theme.error;
  }
}

// ── Sub-components ──────────────────────────────────────────────────

/** Bubble wrapper. Ink Box doesn't support backgroundColor. */
function MessageContent({ children }: { children: ReactNode }) {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} width="85%">
      {children}
    </Box>
  );
}

/** Renders text with word wrap. Pass `isLast` to show the streaming cursor. */
function MessageText({ children, isLast = false }: { children: string; isLast?: boolean }) {
  const { isStreaming, streamingCursor, textColor } = useMessage();

  return (
    <Text wrap="wrap" color={textColor}>
      {children}
      {isLast && isStreaming && <Text dimColor>{streamingCursor}</Text>}
    </Text>
  );
}

/** Collapsible reasoning block rendered as a ChainOfThought. */
function MessageReasoning({
  duration,
  steps,
  collapsed = true,
  children,
}: {
  /** Duration label shown in the header */
  duration?: string;
  /** Structured thinking steps */
  steps?: Step[];
  /** Whether the block starts collapsed */
  collapsed?: boolean;
  /** Freeform content (used when steps are not provided) */
  children?: ReactNode;
}) {
  return (
    <ChainOfThought defaultOpen={!collapsed}>
      <ChainOfThoughtHeader duration={duration} />
      <ChainOfThoughtContent>
        {steps?.map((step, i) => (
          <ChainOfThoughtStep
            key={`${step.tool}-${step.label}`}
            label={step.label}
            description={step.description}
            status={step.status}
            isLast={i === (steps?.length ?? 0) - 1}
          >
            {step.output}
          </ChainOfThoughtStep>
        ))}
        {children}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

/** Tool call with status icon and optional result. */
function MessageToolCall({
  name,
  state = 'pending',
  result,
  color,
}: {
  /** Tool name */
  name: string;
  /** Tool execution state */
  state?: ToolCallState;
  /** Tool result (shown when state is "completed") */
  result?: unknown;
  /** Override the default state color */
  color?: string;
}) {
  const theme = useTheme();
  const { textColor } = useMessage();
  const icon = TOOL_STATE_ICONS[state];
  const stateColor = color ?? getToolStateColor(state, theme);
  const isActive = state === 'pending' || state === 'running';

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={stateColor}>{icon}</Text>
        <Text color={textColor}> </Text>
        <Text color={stateColor} bold={isActive}>
          {name}
        </Text>
        {isActive && (
          <Text color={textColor} dimColor>
            {'...'}
          </Text>
        )}
      </Text>
      {state === 'completed' && result !== undefined && (
        <Text>
          <Text color={textColor} dimColor>
            {'└─'}
          </Text>
          <Text color={textColor} dimColor>
            {String(result).slice(0, MAX_RESULT_PREVIEW_CHARS)}
          </Text>
        </Text>
      )}
      {state === 'error' && result !== undefined && (
        <Text>
          <Text color={theme.error} dimColor>
            {'└─'}
          </Text>
          <Text color={theme.error} dimColor>
            {String(result).slice(0, MAX_RESULT_PREVIEW_CHARS)}
          </Text>
        </Text>
      )}
    </Box>
  );
}

/** Numbered source citation. */
function MessageSource({
  title,
  url,
  index,
}: {
  /** Source title */
  title?: string;
  /** Source URL */
  url?: string;
  /** Zero-based index for the citation number */
  index: number;
}) {
  const theme = useTheme();
  const { textColor } = useMessage();
  const displayTitle = title || url || 'source';

  return (
    <Text>
      <Text color={textColor} dimColor>
        {'['}
      </Text>
      <Text color={theme.accent}>{String(index + 1)}</Text>
      <Text color={textColor} dimColor>
        {']'}
      </Text>
      <Text color={theme.accent}>{displayTitle}</Text>
    </Text>
  );
}

/** Model attribution and timestamp footer. */
function MessageFooter({ model, timestamp }: { model?: string; timestamp?: string }) {
  const theme = useTheme();
  if (!model && !timestamp) {
    return null;
  }

  return (
    <Text>
      {model && (
        <Text color={theme.muted} dimColor>
          {model}
        </Text>
      )}
      {model && timestamp && (
        <Text color={theme.muted} dimColor>
          {'·'}
        </Text>
      )}
      {timestamp && (
        <Text color={theme.muted} dimColor>
          {timestamp}
        </Text>
      )}
    </Text>
  );
}

// ── Message (root component) ────────────────────────────────────────

export interface MessageProps {
  /** Message role — determines alignment and default background. */
  role: MessageRole;
  /** Whether this message is currently streaming. */
  isStreaming?: boolean;
  /** Cursor character shown while streaming. */
  streamingCursor?: string;
  /** Override the default background color. */
  backgroundColor?: string;
  /** Compose sub-components: Message.Content, Message.Text, etc. */
  children: ReactNode;
}

export function Message({
  role,
  isStreaming = false,
  streamingCursor = '\u258E',
  backgroundColor,
  children,
}: MessageProps) {
  const theme = useTheme();
  const { assistantBg, userBg } = getBubbleColors(theme);
  const isUser = role === 'user';
  const bg = backgroundColor ?? (isUser ? userBg : assistantBg);

  return (
    <MessageContext.Provider
      value={{
        role,
        isStreaming,
        streamingCursor,
        backgroundColor: bg,
        textColor: theme.foreground,
      }}
    >
      <Box flexDirection="column" flexShrink={0} alignItems={isUser ? 'flex-end' : 'flex-start'}>
        {children}
      </Box>
    </MessageContext.Provider>
  );
}

// ── Attach sub-components ───────────────────────────────────────────

Message.Content = MessageContent;
Message.Text = MessageText;
Message.Reasoning = MessageReasoning;
Message.ToolCall = MessageToolCall;
Message.Source = MessageSource;
Message.Footer = MessageFooter;
