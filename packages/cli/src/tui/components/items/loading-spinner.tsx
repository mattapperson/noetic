/**
 * Loading spinner component - renders animated loading state inline.
 * Matches Claude Code's SpinnerWithVerb style.
 */

import { Text } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useTheme } from '../theme.js';

//#region Constants

// Spinner verbs - fun loading messages like Claude Code
const SPINNER_VERBS = [
  'Accomplishing',
  'Architecting',
  'Brewing',
  'Calculating',
  'Cogitating',
  'Composing',
  'Computing',
  'Concocting',
  'Considering',
  'Contemplating',
  'Cooking',
  'Crafting',
  'Creating',
  'Crunching',
  'Deliberating',
  'Determining',
  'Generating',
  'Imagining',
  'Musing',
  'Percolating',
  'Pondering',
  'Processing',
  'Ruminating',
  'Synthesizing',
  'Thinking',
  'Working',
] as const;

// Spinner animation frames (braille dots)
const SPINNER_FRAMES = [
  '\u280B', // ⠋
  '\u2819', // ⠙
  '\u2839', // ⠹
  '\u2838', // ⠸
  '\u283C', // ⠼
  '\u2834', // ⠴
  '\u2826', // ⠦
  '\u2827', // ⠧
  '\u2807', // ⠇
  '\u280F', // ⠏
];

const ANIMATION_INTERVAL_MS = 80;

//#endregion

//#region Types

export type SpinnerMode = 'loading' | 'thinking' | 'tool-use';

export interface LoadingSpinnerProps {
  /** Current mode determines messaging */
  mode: SpinnerMode;
  /** Optional override message (e.g., task name) */
  message?: string;
}

//#endregion

//#region Helpers

function getRandomVerb(): string {
  const index = Math.floor(Math.random() * SPINNER_VERBS.length);
  return SPINNER_VERBS[index] ?? 'Working';
}

//#endregion

//#region Component

export function LoadingSpinner({ mode, message }: LoadingSpinnerProps): ReactNode {
  const theme = useTheme();

  // Pick a random verb on mount (stable for the duration of this spinner)
  const [verb] = useState(() => getRandomVerb());

  // Animation frame state
  const [frameIndex, setFrameIndex] = useState(0);

  // Animate spinner
  useEffect(() => {
    const interval = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, ANIMATION_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  const spinnerChar = SPINNER_FRAMES[frameIndex] ?? SPINNER_FRAMES[0];
  const displayMessage = message ?? `${verb}...`;
  const suffix = mode === 'thinking' ? ' (thinking)' : '';

  // Render as a single top-level <Text> (no flex-row Box) so Ink always sees
  // exactly one text node of known height. Ghostty is stricter than most
  // terminals about the cursor-up + erase-line sequences Ink emits between
  // animation frames: when the dynamic region's measured row count drifts
  // for even one tick, the previous spinner line is left behind and the
  // ticks accumulate as a visible column of verbs.
  return (
    <Text>
      <Text color={theme.primary}>{spinnerChar}</Text>
      <Text color={theme.muted}>{` ${displayMessage}${suffix}`}</Text>
    </Text>
  );
}

//#endregion
