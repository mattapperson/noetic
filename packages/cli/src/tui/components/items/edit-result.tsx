/**
 * Renders an Edit tool result as a mini diff hunk with line-numbered gutter,
 * +/- markers, and a 10-line cap with "+N lines (ctrl+o to expand)" suffix.
 */

import { relativizeHome } from '../../paths.js';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { z } from 'zod';
import type { DiffLine, ParsedDiff } from '../../diff/parse-unified-diff.js';
import {
  DiffLineKind,
  flattenHunks,
  gutterWidth,
  markerFor,
  parseUnifiedDiff,
} from '../../diff/parse-unified-diff.js';
import { ELLIPSIS, EXPAND_HINT_TEXT } from '../../glyphs.js';
import { pluralize } from '../../plural.js';
import { parseToolOutput } from '../../tool-output.js';
import type { Theme } from '../theme.js';
import { useTheme } from '../theme.js';
import { MessageResponse } from './message-response.js';

//#region Schemas

const EditOutputShapeSchema = z
  .object({
    path: z.string().optional(),
    success: z.boolean().optional(),
    message: z.string().optional(),
    diff: z.string().optional(),
    firstChangedLine: z.number().optional(),
  })
  .passthrough();

//#endregion

//#region Constants

const MAX_DIFF_LINES = 1e1;

//#endregion

//#region Helpers

function colorFor(kind: DiffLine['kind'], theme: Theme): string | undefined {
  if (kind === DiffLineKind.Add) {
    return theme.success;
  }
  if (kind === DiffLineKind.Del) {
    return theme.error;
  }
  return undefined;
}

function gutterFor(line: DiffLine, gutter: number): string {
  const num = line.newLine ?? line.oldLine;
  const numStr = num === undefined ? '' : String(num);
  return numStr.padStart(gutter, ' ');
}

//#endregion

//#region Sub-components

interface DiffRowProps {
  line: DiffLine;
  lineGutterWidth: number;
}

function DiffRow({ line, lineGutterWidth }: DiffRowProps): ReactNode {
  const theme = useTheme();
  const marker = markerFor(line);
  const gutter = gutterFor(line, lineGutterWidth);
  const color = colorFor(line.kind, theme);
  return (
    <Box flexDirection="row">
      <Text dimColor>{gutter} </Text>
      <Text color={color}>
        {marker} {line.text}
      </Text>
    </Box>
  );
}

interface DiffBodyProps {
  diff: ParsedDiff;
  expanded?: boolean;
}

function keyFor(line: DiffLine): string {
  return `${line.kind}:${line.oldLine ?? '-'}:${line.newLine ?? '-'}`;
}

function DiffBody({ diff, expanded = false }: DiffBodyProps): ReactNode {
  const flat = flattenHunks(diff);
  const visible = expanded ? flat : flat.slice(0, MAX_DIFF_LINES);
  const hidden = flat.length - visible.length;
  const gutter = gutterWidth(diff);
  return (
    <Box flexDirection="column">
      {visible.map((line) => (
        <DiffRow key={keyFor(line)} line={line} lineGutterWidth={gutter} />
      ))}
      {hidden > 0 && (
        <Text dimColor>
          {ELLIPSIS} +{hidden} {pluralize(hidden, 'line', 'lines')} {EXPAND_HINT_TEXT}
        </Text>
      )}
    </Box>
  );
}

//#endregion

//#region Component

export interface EditResultProps {
  output: unknown;
  /** When true, render the full diff with no truncation (for the transcript overlay). */
  expanded?: boolean;
}

export function EditResult({ output, expanded = false }: EditResultProps): ReactNode {
  const parsed = useMemo(
    () => parseToolOutput(EditOutputShapeSchema, output),
    [
      output,
    ],
  );
  const diff = useMemo(() => {
    if (!parsed || parsed.success === false || !parsed.diff) {
      return null;
    }
    return parseUnifiedDiff(parsed.diff);
  }, [
    parsed,
  ]);
  if (!parsed) {
    return null;
  }
  if (parsed.success === false) {
    return (
      <MessageResponse>
        <Text dimColor>{parsed.message ?? 'Edit failed'}</Text>
      </MessageResponse>
    );
  }
  const header = parsed.path ? `Update(${relativizeHome(parsed.path)})` : 'Update';
  if (!diff) {
    return (
      <MessageResponse>
        <Text dimColor>{header}</Text>
      </MessageResponse>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>
        {'  '}
        {header}
      </Text>
      <MessageResponse>
        <Box flexDirection="column">
          <Text dimColor>
            Added {diff.totals.added} {pluralize(diff.totals.added, 'line', 'lines')}
            {diff.totals.removed > 0
              ? `, Removed ${diff.totals.removed} ${pluralize(diff.totals.removed, 'line', 'lines')}`
              : ''}
          </Text>
          <DiffBody diff={diff} expanded={expanded} />
        </Box>
      </MessageResponse>
    </Box>
  );
}

//#endregion
