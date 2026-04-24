import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { createContext, memo, useContext, useEffect, useMemo, useState } from 'react';
import type { Theme } from './theme';
import { useTheme } from './theme';

// ── Constants ──────────────────────────────────────────────────────

const DOTS = [
  '○',
  '◔',
  '◑',
  '◕',
  '●',
] as const;
const SPINNER_INTERVAL = 150;

// ── Step data type (for data-driven usage) ─────────────────────────

export interface Step {
  /** Tool or operation name (e.g. "Think", "Search", "Read"). */
  tool: string;
  /** Primary label for the step. */
  label: string;
  /** Secondary detail shown dimmed after the label. */
  description?: string;
  /** Duration string (e.g. "0.6s", "400ms"). */
  duration?: string;
  /** Current status. */
  status: 'done' | 'running' | 'pending' | 'error';
  /** Output or detail text shown below the step. */
  output?: string;
}

// ── Context ────────────────────────────────────────────────────────

interface ChainOfThoughtContextValue {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

const ChainOfThoughtContext = createContext<ChainOfThoughtContextValue | null>(null);

const useChainOfThought = () => {
  const context = useContext(ChainOfThoughtContext);
  if (!context) {
    throw new Error('ChainOfThought components must be used within <ChainOfThought>');
  }
  return context;
};

// ── Status helper ──────────────────────────────────────────────────

function getStepColor(status: string, theme: Theme): string {
  switch (status) {
    case 'done':
      return theme.success;
    case 'running':
      return theme.primary;
    case 'pending':
      return theme.muted;
    case 'error':
      return theme.error;
    default:
      return theme.muted;
  }
}

// ── ChainOfThought (root) ──────────────────────────────────────────

export interface ChainOfThoughtProps {
  /** Controlled open state. */
  open?: boolean;
  /** Default open state (uncontrolled). Defaults to false. */
  defaultOpen?: boolean;
  /** Called when the open state changes. */
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

export const ChainOfThought = memo(
  ({ open, defaultOpen = false, onOpenChange, children }: ChainOfThoughtProps) => {
    const [internalOpen, setInternalOpen] = useState(defaultOpen);
    const isOpen = open ?? internalOpen;
    const setIsOpen = onOpenChange ?? setInternalOpen;

    const context = useMemo(
      () => ({
        isOpen,
        setIsOpen,
      }),
      [
        isOpen,
        setIsOpen,
      ],
    );

    return (
      <ChainOfThoughtContext.Provider value={context}>
        <Box flexDirection="column">{children}</Box>
      </ChainOfThoughtContext.Provider>
    );
  },
);

// ── ChainOfThoughtHeader ───────────────────────────────────────────

export interface ChainOfThoughtHeaderProps {
  /** Duration string shown after the label (e.g. "3.2s"). */
  duration?: string;
  /** Header label content. Defaults to "Thought for". */
  children?: ReactNode;
}

export const ChainOfThoughtHeader = memo(
  ({ duration, children = 'Thought for' }: ChainOfThoughtHeaderProps) => {
    const theme = useTheme();
    const { isOpen } = useChainOfThought();
    const arrow = isOpen ? '▼' : '▶';

    return (
      <Text>
        <Text color={theme.muted}>{arrow}</Text>
        <Text dimColor color={theme.muted}>
          {' '}
          {children}
          {duration ? ' ' + duration : ''}
        </Text>
      </Text>
    );
  },
);

// ── ChainOfThoughtContent ──────────────────────────────────────────

export interface ChainOfThoughtContentProps {
  children: ReactNode;
}

export const ChainOfThoughtContent = memo(({ children }: ChainOfThoughtContentProps) => {
  const { isOpen } = useChainOfThought();
  if (!isOpen) {
    return null;
  }
  return <>{children}</>;
});

// ── ChainOfThoughtStep ─────────────────────────────────────────────

export interface ChainOfThoughtStepProps {
  /** Primary label for the step. */
  label: string;
  /** Secondary detail shown dimmed after the label. */
  description?: string;
  /** Current status. Defaults to "done". */
  status?: 'done' | 'running' | 'pending' | 'error';
  /** Set to true to hide the vertical pipe connector below. */
  isLast?: boolean;
  /** Output content rendered below the step with a pipe gutter. */
  children?: ReactNode;
}

export const ChainOfThoughtStep = memo(
  ({ label, description, status = 'done', isLast = false, children }: ChainOfThoughtStepProps) => {
    const theme = useTheme();
    const isActive = status === 'running';
    const isPending = status === 'pending';
    const color = getStepColor(status, theme);
    const pipe = '│';

    // Self-contained spinner animation — only ticks when this step is active
    const [frame, setFrame] = useState(0);
    useEffect(() => {
      if (!isActive) {
        setFrame(0);
        return;
      }
      const id = setInterval(() => setFrame((f) => f + 1), SPINNER_INTERVAL);
      return () => clearInterval(id);
    }, [
      isActive,
    ]);

    const dot = isActive ? DOTS[frame % DOTS.length]! : isPending ? '○' : '●';

    return (
      <Box flexDirection="column" marginLeft={1}>
        <Text>
          <Text color={color}>{dot}</Text>
          <Text color={theme.foreground}> </Text>
          <Text color={isPending ? theme.muted : color} dimColor={isPending} bold={isActive}>
            {label}
          </Text>
          {description && (
            <Text dimColor color={theme.muted}>
              {' — ' + description}
            </Text>
          )}
        </Text>
        {children && (
          <Text>
            <Text color={color} dimColor>
              {pipe + ' '}
            </Text>
            <Text color={status === 'error' ? theme.error : theme.accent}>{children}</Text>
          </Text>
        )}
        {!isLast && (
          <Text>
            <Text color={color} dimColor>
              {pipe}
            </Text>
          </Text>
        )}
      </Box>
    );
  },
);

// ── Display names ──────────────────────────────────────────────────

ChainOfThought.displayName = 'ChainOfThought';
ChainOfThoughtHeader.displayName = 'ChainOfThoughtHeader';
ChainOfThoughtContent.displayName = 'ChainOfThoughtContent';
ChainOfThoughtStep.displayName = 'ChainOfThoughtStep';
