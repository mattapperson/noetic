/**
 * Renders an `lsp` tool result under its ToolCall header as:
 *   ⎿ <multi-line results text>
 *      … +N lines (ctrl+o to expand)
 *
 * The LSP tool returns a pre-formatted human-readable `results` string — this
 * component just slices it for the collapsed view and shows the full text in
 * the transcript overlay.
 *
 * Deliberately does NOT render its own `⏺ lsp(…)` header: the ToolCall entry
 * immediately above already shows `⏺ lsp(hover src/foo.ts:42:10)` via
 * `previewToolArgs('lsp', …)`. `BashResult` duplicates its header; we don't
 * repeat that here.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { z } from 'zod';
import { ELLIPSIS, EXPAND_HINT_TEXT } from '../../glyphs.js';
import { pluralize } from '../../plural.js';
import { parseToolOutput } from '../../tool-output.js';
import { useTheme } from '../theme.js';
import { MessageResponse } from './message-response.js';

//#region Schemas

const LspOutputShapeSchema = z
  .object({
    operation: z.string().optional(),
    results: z.string().optional(),
  })
  .passthrough();

//#endregion

//#region Constants

export const MAX_RESULT_LINES = 1e1;

//#endregion

//#region Helpers

export interface ResultsSlice {
  visible: string[];
  hidden: number;
}

export function sliceResults(raw: string, expanded: boolean): ResultsSlice {
  if (!raw) {
    return {
      visible: [],
      hidden: 0,
    };
  }
  const lines = raw.split('\n');
  // Drop a single trailing empty string so `"a\nb\n"` renders as 2 lines, not 3.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const visible = expanded ? lines : lines.slice(0, MAX_RESULT_LINES);
  return {
    visible,
    hidden: lines.length - visible.length,
  };
}

//#endregion

//#region Component

export interface LspResultProps {
  output: unknown;
  /** Whether the parent call errored. Colors the body red. */
  isError?: boolean;
  /** When true, render the full results with no truncation (for the transcript overlay). */
  expanded?: boolean;
  /**
   * Rendered when the output can't be parsed into the expected `{operation, results}`
   * shape or the `results` string is empty. Without this the user would see the
   * ToolCall header with no body at all — worse UX than the generic `ToolResult`.
   */
  fallback?: ReactNode;
}

export function LspResult({
  output,
  isError = false,
  expanded = false,
  fallback = null,
}: LspResultProps): ReactNode {
  const theme = useTheme();
  const parsed = useMemo(
    () => parseToolOutput(LspOutputShapeSchema, output),
    [
      output,
    ],
  );
  const slice = useMemo(
    () => sliceResults(parsed?.results ?? '', expanded),
    [
      parsed,
      expanded,
    ],
  );
  if (!parsed || slice.visible.length === 0) {
    return fallback;
  }
  const bodyColor = isError ? theme.error : undefined;
  const body = slice.visible.join('\n');
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color={bodyColor} dimColor={!isError}>
          {body}
        </Text>
        {slice.hidden > 0 && (
          <Text dimColor>
            {ELLIPSIS} +{slice.hidden} {pluralize(slice.hidden, 'line', 'lines')} {EXPAND_HINT_TEXT}
          </Text>
        )}
      </Box>
    </MessageResponse>
  );
}

//#endregion
