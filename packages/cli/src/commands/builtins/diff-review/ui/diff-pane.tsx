/**
 * Right-pane diff renderer.
 *
 * Renders the unified or side-by-side diff for the currently-selected file.
 * Cursor + comment markers are drawn in the gutter so the user can target a
 * specific line for a comment with `c`. Binary/image files render a status
 * badge — comments on those files are file-level only.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { useTheme } from '../../../../tui/components/theme.js';
import type { DiffReviewComment, ReviewFile, ReviewFileContents } from '../types.js';
import { ChangeStatus, CommentSide, ReviewFileKind } from '../types.js';
import type { DiffLine, ParsedDiff } from './diff-utils.js';
import { buildDiff, DiffLineKind, flattenHunks, gutterWidth, markerFor } from './diff-utils.js';
import type { State } from './state.js';
import { Layout, Pane } from './state.js';

//#region Props

export interface DiffPaneProps {
  state: State;
  file: ReviewFile | undefined;
  contents: ReviewFileContents | undefined;
  width: number;
  height: number;
}

//#endregion

//#region Helpers

interface MarkerLookupArgs {
  comments: ReadonlyArray<DiffReviewComment>;
  fileId: string;
  side: CommentSide;
  lineNumber: number | undefined;
}

function findCommentMarkerForLine(args: MarkerLookupArgs): boolean {
  const { comments, fileId, side, lineNumber } = args;
  if (lineNumber === undefined) {
    return false;
  }
  for (const c of comments) {
    if (c.fileId !== fileId) {
      continue;
    }
    if (c.side !== side) {
      continue;
    }
    if (c.startLine === null) {
      continue;
    }
    const start = c.startLine;
    const end = c.endLine ?? c.startLine;
    if (lineNumber >= start && lineNumber <= end) {
      return true;
    }
  }
  return false;
}

function lineNumberForCursor(line: DiffLine): number | undefined {
  return line.newLine ?? line.oldLine;
}

function colorFor(
  line: DiffLine,
  theme: {
    success: string;
    error: string;
    foreground: string;
  },
): string {
  if (line.kind === DiffLineKind.Add) {
    return theme.success;
  }
  if (line.kind === DiffLineKind.Del) {
    return theme.error;
  }
  return theme.foreground;
}

//#endregion

//#region Sub-components

interface UnifiedRowProps {
  line: DiffLine;
  gutter: number;
  hasComment: boolean;
  isCursor: boolean;
}

function UnifiedRow({ line, gutter, hasComment, isCursor }: UnifiedRowProps): ReactNode {
  const theme = useTheme();
  const lineNum = line.newLine ?? line.oldLine;
  const numStr = lineNum === undefined ? '' : String(lineNum);
  const padded = numStr.padStart(gutter, ' ');
  const cursorGlyph = isCursor ? '❯' : ' ';
  const commentGlyph = hasComment ? '▌' : ' ';
  const color = colorFor(line, theme);
  return (
    <Box flexDirection="row">
      <Text color={theme.primary}>{cursorGlyph}</Text>
      <Text color={theme.warning}>{commentGlyph}</Text>
      <Text dimColor>{padded} </Text>
      <Text color={color}>
        {markerFor(line)} {line.text}
      </Text>
    </Box>
  );
}

interface SideBySideRowProps {
  oldLine: DiffLine | null;
  newLine: DiffLine | null;
  gutter: number;
  half: number;
  oldHasComment: boolean;
  newHasComment: boolean;
  oldIsCursor: boolean;
  newIsCursor: boolean;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  if (max <= 1) {
    return '…';
  }
  return `${text.slice(0, max - 1)}…`;
}

function SideBySideRow(props: SideBySideRowProps): ReactNode {
  const theme = useTheme();
  const cellWidth = Math.max(8, props.half - props.gutter - 4);
  const oldNum =
    props.oldLine && props.oldLine.oldLine !== undefined ? String(props.oldLine.oldLine) : '';
  const newNum =
    props.newLine && props.newLine.newLine !== undefined ? String(props.newLine.newLine) : '';
  const oldText = props.oldLine ? truncate(props.oldLine.text, cellWidth) : '';
  const newText = props.newLine ? truncate(props.newLine.text, cellWidth) : '';
  const oldColor = props.oldLine ? colorFor(props.oldLine, theme) : theme.foreground;
  const newColor = props.newLine ? colorFor(props.newLine, theme) : theme.foreground;
  return (
    <Box flexDirection="row">
      <Text color={theme.primary}>{props.oldIsCursor ? '❯' : ' '}</Text>
      <Text color={theme.warning}>{props.oldHasComment ? '▌' : ' '}</Text>
      <Text dimColor>{oldNum.padStart(props.gutter, ' ')} </Text>
      <Text color={oldColor}>
        {props.oldLine ? markerFor(props.oldLine) : ' '} {oldText.padEnd(cellWidth, ' ')}
      </Text>
      <Text dimColor>│</Text>
      <Text color={theme.primary}>{props.newIsCursor ? '❯' : ' '}</Text>
      <Text color={theme.warning}>{props.newHasComment ? '▌' : ' '}</Text>
      <Text dimColor>{newNum.padStart(props.gutter, ' ')} </Text>
      <Text color={newColor}>
        {props.newLine ? markerFor(props.newLine) : ' '} {newText}
      </Text>
    </Box>
  );
}

//#endregion

//#region Layouts

interface UnifiedLayoutProps {
  diff: ParsedDiff;
  state: State;
  fileId: string;
  height: number;
}

function visibleSlice<T>(
  items: ReadonlyArray<T>,
  cursor: number,
  size: number,
): {
  start: number;
  end: number;
} {
  if (items.length <= size) {
    return {
      start: 0,
      end: items.length,
    };
  }
  const half = Math.floor(size / 2);
  let start = Math.max(0, cursor - half);
  const end = Math.min(items.length, start + size);
  start = Math.max(0, end - size);
  return {
    start,
    end,
  };
}

function UnifiedLayout({ diff, state, fileId, height }: UnifiedLayoutProps): ReactNode {
  const flat = useMemo(
    () => flattenHunks(diff),
    [
      diff,
    ],
  );
  const gutter = useMemo(
    () => gutterWidth(diff),
    [
      diff,
    ],
  );
  const cursor = state.activePane === Pane.Diff ? state.cursorIndex : -1;
  const { start, end } = visibleSlice(flat, Math.max(0, cursor), Math.max(1, height - 2));
  const visible = flat.slice(start, end);
  return (
    <Box flexDirection="column">
      {start > 0 ? <Text dimColor> ↑ {start} more above</Text> : null}
      {visible.map((line, idx) => {
        const absoluteIdx = start + idx;
        const lineNum = lineNumberForCursor(line);
        const side = line.kind === DiffLineKind.Del ? CommentSide.Original : CommentSide.Modified;
        const hasComment = findCommentMarkerForLine({
          comments: state.comments,
          fileId,
          side,
          lineNumber: lineNum,
        });
        return (
          <UnifiedRow
            key={`${line.kind}:${line.oldLine ?? '-'}:${line.newLine ?? '-'}:${absoluteIdx}`}
            line={line}
            gutter={gutter}
            hasComment={hasComment}
            isCursor={absoluteIdx === cursor}
          />
        );
      })}
      {end < flat.length ? <Text dimColor> ↓ {flat.length - end} more below</Text> : null}
    </Box>
  );
}

interface SideBySideLayoutProps {
  diff: ParsedDiff;
  state: State;
  fileId: string;
  width: number;
  height: number;
}

interface SideBySidePair {
  old: DiffLine | null;
  new: DiffLine | null;
}

function pairLines(diff: ParsedDiff): SideBySidePair[] {
  const pairs: SideBySidePair[] = [];
  for (const hunk of diff.hunks) {
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    for (const line of hunk.lines) {
      if (line.kind === DiffLineKind.Ctx) {
        // Flush any pending del/add before context
        const max = Math.max(dels.length, adds.length);
        for (let i = 0; i < max; i += 1) {
          pairs.push({
            old: dels[i] ?? null,
            new: adds[i] ?? null,
          });
        }
        dels.length = 0;
        adds.length = 0;
        pairs.push({
          old: line,
          new: line,
        });
        continue;
      }
      if (line.kind === DiffLineKind.Del) {
        dels.push(line);
        continue;
      }
      adds.push(line);
    }
    const max = Math.max(dels.length, adds.length);
    for (let i = 0; i < max; i += 1) {
      pairs.push({
        old: dels[i] ?? null,
        new: adds[i] ?? null,
      });
    }
  }
  return pairs;
}

function SideBySideLayout({
  diff,
  state,
  fileId,
  width,
  height,
}: SideBySideLayoutProps): ReactNode {
  const pairs = useMemo(
    () => pairLines(diff),
    [
      diff,
    ],
  );
  const gutter = useMemo(
    () => gutterWidth(diff),
    [
      diff,
    ],
  );
  const half = Math.floor(width / 2);
  const cursor = state.activePane === Pane.Diff ? state.cursorIndex : -1;
  const { start, end } = visibleSlice(pairs, Math.max(0, cursor), Math.max(1, height - 2));
  const visible = pairs.slice(start, end);
  return (
    <Box flexDirection="column">
      {start > 0 ? <Text dimColor> ↑ {start} more above</Text> : null}
      {visible.map((pair, idx) => {
        const absoluteIdx = start + idx;
        const oldLineNum = pair.old?.oldLine;
        const newLineNum = pair.new?.newLine;
        const oldHasComment = findCommentMarkerForLine({
          comments: state.comments,
          fileId,
          side: CommentSide.Original,
          lineNumber: oldLineNum,
        });
        const newHasComment = findCommentMarkerForLine({
          comments: state.comments,
          fileId,
          side: CommentSide.Modified,
          lineNumber: newLineNum,
        });
        return (
          <SideBySideRow
            key={`pair:${oldLineNum ?? '-'}:${newLineNum ?? '-'}:${absoluteIdx}`}
            oldLine={pair.old}
            newLine={pair.new}
            gutter={gutter}
            half={half}
            oldHasComment={oldHasComment}
            newHasComment={newHasComment}
            oldIsCursor={absoluteIdx === cursor}
            newIsCursor={absoluteIdx === cursor}
          />
        );
      })}
      {end < pairs.length ? <Text dimColor> ↓ {pairs.length - end} more below</Text> : null}
    </Box>
  );
}

//#endregion

//#region Empty / status states

function NoFile(): ReactNode {
  return (
    <Box paddingX={2} paddingY={1}>
      <Text dimColor>Select a file from the left pane.</Text>
    </Box>
  );
}

interface BinaryBadgeProps {
  file: ReviewFile;
}

function BinaryBadge({ file }: BinaryBadgeProps): ReactNode {
  const theme = useTheme();
  const status = file.gitDiff?.status ?? file.worktreeStatus ?? ChangeStatus.Modified;
  const label = file.kind === ReviewFileKind.Image ? `[image ${file.mimeType ?? ''}]` : '[binary]';
  return (
    <Box paddingX={2} paddingY={1} flexDirection="column">
      <Text color={theme.muted}>
        {label} {file.path}
      </Text>
      <Text dimColor>Status: {status}</Text>
      <Text dimColor>Press `c` to leave a file-level comment.</Text>
    </Box>
  );
}

function NoChanges({ file }: { file: ReviewFile }): ReactNode {
  return (
    <Box paddingX={2} paddingY={1} flexDirection="column">
      <Text dimColor>No textual changes for {file.gitDiff?.displayPath ?? file.path}.</Text>
    </Box>
  );
}

//#endregion

//#region Public component

export function DiffPane({ state, file, contents, width, height }: DiffPaneProps): ReactNode {
  const theme = useTheme();
  // Hooks must run unconditionally — compute the diff up-front and let the
  // render branches consume the cached value. Re-running createTwoFilesPatch
  // on every keypress would scan the full file twice; memoise on the actual
  // text content + paths.
  const diff = useMemo(() => {
    if (!file || file.kind !== ReviewFileKind.Text || !contents) {
      return null;
    }
    return buildDiff({
      originalContent: contents.originalContent,
      modifiedContent: contents.modifiedContent,
      originalPath: file.gitDiff?.oldPath ?? file.path,
      modifiedPath: file.gitDiff?.newPath ?? file.path,
    });
  }, [
    file,
    contents,
  ]);

  if (file === undefined) {
    return (
      <Box
        width={width}
        height={height}
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.border}
      >
        <NoFile />
      </Box>
    );
  }

  const header = (
    <Box>
      <Text bold color={theme.accent}>
        {file.gitDiff?.displayPath ?? file.path}
      </Text>
    </Box>
  );

  if (file.kind !== ReviewFileKind.Text) {
    return (
      <Box
        width={width}
        height={height}
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.border}
      >
        {header}
        <BinaryBadge file={file} />
      </Box>
    );
  }

  if (contents === undefined) {
    return (
      <Box
        width={width}
        height={height}
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.border}
      >
        {header}
        <Box paddingX={2} paddingY={1}>
          <Text dimColor>Loading…</Text>
        </Box>
      </Box>
    );
  }

  if (diff === null) {
    return (
      <Box
        width={width}
        height={height}
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.border}
      >
        {header}
        <NoChanges file={file} />
      </Box>
    );
  }

  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.border}
    >
      {header}
      <Text dimColor>
        +{diff.totals.added} −{diff.totals.removed}
      </Text>
      {state.layout === Layout.SideBySide ? (
        <SideBySideLayout
          diff={diff}
          state={state}
          fileId={file.id}
          width={width}
          height={height - 3}
        />
      ) : (
        <UnifiedLayout diff={diff} state={state} fileId={file.id} height={height - 3} />
      )}
    </Box>
  );
}

//#endregion
