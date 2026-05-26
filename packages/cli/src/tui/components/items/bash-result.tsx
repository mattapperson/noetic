/**
 * Renders a Bash tool result as:
 *   ⏺ Bash(<cmd-truncated>)
 *   ⎿ <output-preview>
 *      … +N lines (ctrl+o to expand)
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { z } from 'zod';
import { BLACK_CIRCLE, ELLIPSIS, EXPAND_HINT_TEXT } from '../../glyphs.js';
import { pluralize } from '../../plural.js';
import { parseToolOutput } from '../../tool-output.js';
import { MessageResponse } from './message-response.js';

//#region Schemas

const BashOutputShapeSchema = z
  .object({
    command: z.string().optional(),
    output: z.string().optional(),
    exitCode: z.number().optional(),
    cancelled: z.boolean().optional(),
    truncated: z.boolean().optional(),
  })
  .passthrough();

//#endregion

//#region Constants

const MAX_OUTPUT_LINES = 1e1;
const MAX_COMMAND_CHARS = 8e1;

//#endregion

//#region Helpers

function truncateCommand(cmd: string): string {
  const firstLine = cmd.split('\n')[0] ?? '';
  const hasMoreLines = cmd.includes('\n');
  if (firstLine.length <= MAX_COMMAND_CHARS) {
    return hasMoreLines ? `${firstLine}${ELLIPSIS}` : firstLine;
  }
  return `${firstLine.slice(0, MAX_COMMAND_CHARS)}${ELLIPSIS}`;
}

interface OutputSlice {
  visible: string[];
  hidden: number;
}

function sliceOutput(raw: string, expanded: boolean): OutputSlice {
  if (!raw) {
    return {
      visible: [],
      hidden: 0,
    };
  }
  const lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const visible = expanded ? lines : lines.slice(0, MAX_OUTPUT_LINES);
  return {
    visible,
    hidden: lines.length - visible.length,
  };
}

//#endregion

//#region Component

export interface BashResultProps {
  output: unknown;
  /** When true, render the full output with no truncation (for the transcript overlay). */
  expanded?: boolean;
}

export function BashResult({ output, expanded = false }: BashResultProps): ReactNode {
  const parsed = useMemo(
    () => parseToolOutput(BashOutputShapeSchema, output),
    [
      output,
    ],
  );
  const slice = useMemo(
    () => sliceOutput(parsed?.output ?? '', expanded),
    [
      parsed,
      expanded,
    ],
  );
  if (!parsed) {
    return null;
  }
  const header = parsed.command ? `Bash(${truncateCommand(parsed.command)})` : 'Bash';
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="nowrap">
        <Box minWidth={2}>
          <Text>{BLACK_CIRCLE}</Text>
        </Box>
        <Text bold wrap="truncate-end">
          {header}
        </Text>
      </Box>
      {slice.visible.length > 0 && (
        <MessageResponse>
          <Box flexDirection="column">
            {slice.visible.map((line, idx) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: output lines are append-only, stable by position, may duplicate
              <Text key={idx} dimColor>
                {line}
              </Text>
            ))}
            {slice.hidden > 0 && (
              <Text dimColor>
                {ELLIPSIS} +{slice.hidden} {pluralize(slice.hidden, 'line', 'lines')}{' '}
                {EXPAND_HINT_TEXT}
              </Text>
            )}
          </Box>
        </MessageResponse>
      )}
    </Box>
  );
}

//#endregion
