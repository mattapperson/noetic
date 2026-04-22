/**
 * Loading spinner component - renders animated loading state inline.
 * Matches Claude Code's SpinnerWithVerb style and, while a turn is active,
 * shows elapsed time, live token counts, and tok/s throughput.
 */

import { Text } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { LiveTokens, StreamMetricsRefs } from '../../stream-metrics-context.js';
import { useStreamMetrics } from '../../stream-metrics-context.js';
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
  '⠋', // ⠋
  '⠙', // ⠙
  '⠹', // ⠹
  '⠸', // ⠸
  '⠼', // ⠼
  '⠴', // ⠴
  '⠦', // ⠦
  '⠧', // ⠧
  '⠇', // ⠇
  '⠏', // ⠏
];

const ANIMATION_INTERVAL_MS = 80;
/** Minimum elapsed time from first-token before we publish a tok/s estimate —
 *  under 500ms the rate is extremely noisy and jumps around. */
const TOK_PER_SEC_MIN_WINDOW_MS = 5e2;
/** Rough OpenAI-style character-to-token ratio used to estimate output tokens
 *  while streaming (exact count only arrives on turn_completed). */
const CHARS_PER_TOKEN = 4;

//#endregion

//#region Types

export type SpinnerMode = 'loading' | 'thinking' | 'tool-use';

export interface LoadingSpinnerProps {
  /** Current mode determines messaging */
  mode: SpinnerMode;
  /** Optional override message (e.g., task name) */
  message?: string;
}

interface LiveMetricsSnapshot {
  elapsedSec: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  tokPerSec: number | null;
}

//#endregion

//#region Helpers

function getRandomVerb(): string {
  const index = Math.floor(Math.random() * SPINNER_VERBS.length);
  return SPINNER_VERBS[index] ?? 'Working';
}

function snapshotMetrics(refs: StreamMetricsRefs | null, now: number): LiveMetricsSnapshot {
  const empty: LiveMetricsSnapshot = {
    elapsedSec: null,
    inputTokens: null,
    outputTokens: null,
    tokPerSec: null,
  };
  if (refs === null) {
    return empty;
  }
  const startedAt = refs.turnStartedAt.current;
  if (startedAt === null) {
    return empty;
  }
  const tokens: LiveTokens | null = refs.liveTokens.current;
  const chars = refs.liveOutputChars.current;
  const estimatedOutput = Math.max(0, Math.round(chars / CHARS_PER_TOKEN));
  const outputTokens = tokens !== null ? tokens.output : estimatedOutput;
  const inputTokens = tokens !== null ? tokens.input : null;
  const firstTokenAt = refs.firstTokenAt.current;
  let tokPerSec: number | null = null;
  if (firstTokenAt !== null) {
    const windowMs = now - firstTokenAt;
    if (windowMs >= TOK_PER_SEC_MIN_WINDOW_MS && outputTokens > 0) {
      tokPerSec = outputTokens / (windowMs / 1e3);
    }
  }
  return {
    elapsedSec: (now - startedAt) / 1e3,
    inputTokens,
    outputTokens,
    tokPerSec,
  };
}

function formatSeconds(sec: number): string {
  if (sec < 1) {
    return '0s';
  }
  if (sec < 60) {
    return `${Math.floor(sec)}s`;
  }
  const mins = Math.floor(sec / 60);
  const rem = Math.floor(sec % 60);
  return `${mins}m${rem}s`;
}

function formatTokens(n: number): string {
  if (n < 1e3) {
    return String(n);
  }
  return `${(n / 1e3).toFixed(1)}k`;
}

function formatTokPerSec(rate: number): string {
  if (rate >= 1e2) {
    return `${Math.round(rate)} tok/s`;
  }
  return `${rate.toFixed(1)} tok/s`;
}

function buildMetricsSuffix(snapshot: LiveMetricsSnapshot): string {
  if (snapshot.elapsedSec === null) {
    return '';
  }
  const parts: string[] = [
    formatSeconds(snapshot.elapsedSec),
  ];
  const hasInput = snapshot.inputTokens !== null;
  const hasOutput = snapshot.outputTokens !== null && snapshot.outputTokens > 0;
  if (hasInput || hasOutput) {
    const up = hasInput && snapshot.inputTokens !== null ? formatTokens(snapshot.inputTokens) : '—';
    const down =
      hasOutput && snapshot.outputTokens !== null ? formatTokens(snapshot.outputTokens) : '—';
    parts.push(`↑${up} ↓${down}`);
  }
  if (snapshot.tokPerSec !== null) {
    parts.push(formatTokPerSec(snapshot.tokPerSec));
  }
  return ` · ${parts.join(' · ')}`;
}

//#endregion

//#region Component

export function LoadingSpinner({ mode, message }: LoadingSpinnerProps): ReactNode {
  const theme = useTheme();
  const streamMetrics = useStreamMetrics();

  // Pick a random verb on mount (stable for the duration of this spinner)
  const [verb] = useState(() => getRandomVerb());

  // `tick` drives re-render on every animation frame so both the spinner
  // glyph AND the metrics suffix update together without React re-rendering
  // the whole app tree per streaming chunk.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, ANIMATION_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const spinnerChar = SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
  const displayMessage = message ?? `${verb}...`;
  const modeSuffix = mode === 'thinking' ? ' (thinking)' : '';
  const metricsSuffix = buildMetricsSuffix(snapshotMetrics(streamMetrics, Date.now()));

  // Render as a single top-level <Text> (no flex-row Box) so Ink always sees
  // exactly one text node of known height. Ghostty is stricter than most
  // terminals about the cursor-up + erase-line sequences Ink emits between
  // animation frames: when the dynamic region's measured row count drifts
  // for even one tick, the previous spinner line is left behind and the
  // ticks accumulate as a visible column of verbs.
  return (
    <Text>
      <Text color={theme.primary}>{spinnerChar}</Text>
      <Text color={theme.muted}>{` ${displayMessage}${modeSuffix}${metricsSuffix}`}</Text>
    </Text>
  );
}

//#endregion
