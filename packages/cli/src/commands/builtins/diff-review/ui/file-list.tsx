/**
 * Left-pane file/commit list.
 *
 * Three render modes keyed off the current scope:
 *   - Branch: flat list of changed files for the current branch diff.
 *   - All:    flat list of files (same source — all repo files surface only
 *             when the user explicitly hits the "all" tab).
 *   - Commits: two-level — list commits first; once one is selected, render
 *              its files (loaded lazily via getCommitFiles).
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { useTheme } from '../../../../tui/components/theme.js';
import type { ReviewCommitInfo, ReviewFile } from '../types.js';
import { ChangeStatus, ReviewScope } from '../types.js';
import type { State } from './state.js';
import { Pane } from './state.js';

//#region Helpers

function statusGlyph(status: ChangeStatus | null): string {
  if (status === ChangeStatus.Added) {
    return 'A';
  }
  if (status === ChangeStatus.Deleted) {
    return 'D';
  }
  if (status === ChangeStatus.Renamed) {
    return 'R';
  }
  if (status === ChangeStatus.Modified) {
    return 'M';
  }
  return ' ';
}

function statusColor(
  status: ChangeStatus | null,
  theme: {
    success: string;
    error: string;
    accent: string;
    foreground: string;
  },
): string {
  if (status === ChangeStatus.Added) {
    return theme.success;
  }
  if (status === ChangeStatus.Deleted) {
    return theme.error;
  }
  if (status === ChangeStatus.Renamed) {
    return theme.accent;
  }
  return theme.foreground;
}

function buildCommentCountMap(comments: State['comments']): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of comments) {
    map.set(c.fileId, (map.get(c.fileId) ?? 0) + 1);
  }
  return map;
}

//#endregion

//#region Subviews

interface FileRowProps {
  file: ReviewFile;
  isSelected: boolean;
  isFocused: boolean;
  commentCount: number;
}

function FileRow({ file, isSelected, isFocused, commentCount }: FileRowProps): ReactNode {
  const theme = useTheme();
  const status = file.worktreeStatus ?? file.gitDiff?.status ?? null;
  const glyph = statusGlyph(status);
  const color = statusColor(status, theme);
  const marker = isFocused ? '❯' : ' ';
  const display = file.gitDiff?.displayPath ?? file.path;
  return (
    <Box>
      <Text color={isFocused ? theme.primary : theme.muted}>{marker} </Text>
      <Text color={color}>{glyph} </Text>
      <Text bold={isSelected} color={isSelected ? theme.accent : theme.foreground}>
        {display}
      </Text>
      {commentCount > 0 ? <Text color={theme.warning}> ({commentCount})</Text> : null}
    </Box>
  );
}

interface CommitRowProps {
  commit: ReviewCommitInfo;
  isSelected: boolean;
  isFocused: boolean;
}

function CommitRow({ commit, isSelected, isFocused }: CommitRowProps): ReactNode {
  const theme = useTheme();
  const marker = isFocused ? '❯' : ' ';
  const subject = commit.subject || '(no subject)';
  return (
    <Box>
      <Text color={isFocused ? theme.primary : theme.muted}>{marker} </Text>
      <Text color={theme.accent}>{commit.shortSha} </Text>
      <Text bold={isSelected} color={isSelected ? theme.accent : theme.foreground}>
        {subject}
      </Text>
    </Box>
  );
}

//#endregion

//#region Component

export interface FileListProps {
  state: State;
  width: number;
}

export function FileList({ state, width }: FileListProps): ReactNode {
  const theme = useTheme();
  const isFocused = state.activePane === Pane.Files;

  if (state.scope === ReviewScope.Commits && state.selectedCommitSha === null) {
    return renderCommitList({
      state,
      theme,
      isFocused,
      width,
    });
  }

  return renderFileList({
    state,
    theme,
    isFocused,
    width,
  });
}

interface FileListTheme {
  primary: string;
  accent: string;
  muted: string;
  foreground: string;
  border: string;
}

interface RenderArgs {
  state: State;
  theme: FileListTheme;
  isFocused: boolean;
  width: number;
}

function renderCommitList(args: RenderArgs): ReactNode {
  const { state, theme, isFocused, width } = args;
  const commits = state.reviewData.commits;
  if (commits.length === 0) {
    return (
      <Box width={width} flexDirection="column" paddingX={1}>
        <Text dimColor>No commits in range.</Text>
      </Box>
    );
  }
  return (
    <Box width={width} flexDirection="column" paddingX={1}>
      <Text bold color={isFocused ? theme.primary : theme.muted}>
        Commits ({commits.length})
      </Text>
      {commits.map((commit, idx) => (
        <CommitRow
          key={commit.sha}
          commit={commit}
          isSelected={state.selectedCommitSha === commit.sha}
          isFocused={isFocused && state.cursorIndex === idx}
        />
      ))}
    </Box>
  );
}

function renderFileList(args: RenderArgs): ReactNode {
  const { state, theme, isFocused, width } = args;
  const files =
    state.scope === ReviewScope.Commits && state.selectedCommitSha !== null
      ? (state.commitFiles.get(state.selectedCommitSha) ?? [])
      : state.reviewData.files;
  if (files.length === 0) {
    return (
      <Box width={width} flexDirection="column" paddingX={1}>
        <Text dimColor>No files.</Text>
      </Box>
    );
  }
  const commentCounts = buildCommentCountMap(state.comments);
  return (
    <Box width={width} flexDirection="column" paddingX={1}>
      <Text bold color={isFocused ? theme.primary : theme.muted}>
        Files ({files.length})
      </Text>
      {files.map((file, idx) => (
        <FileRow
          key={file.id}
          file={file}
          isSelected={state.selectedFileId === file.id}
          isFocused={isFocused && state.cursorIndex === idx}
          commentCount={commentCounts.get(file.id) ?? 0}
        />
      ))}
    </Box>
  );
}

//#endregion
