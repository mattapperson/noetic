/**
 * Root diff-review modal.
 *
 * Owns the reducer, dispatches async git fetches as side effects, and routes
 * keypresses to the right pane / sub-modal. The four sub-modals it can render
 * (browse / comment / overall / submit-confirm) are mutually exclusive.
 */

import { Box, Text, useInput, useStdout } from 'ink';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import { useTheme } from '../../../../tui/components/theme.js';
import { getCommitFiles, loadReviewFileContents } from '../git.js';
import { composeReviewPrompt } from '../prompt.js';
import type {
  DiffReviewComment,
  ReviewCommitInfo,
  ReviewFile,
  ReviewWindowData,
} from '../types.js';
import { CommentSide, ReviewScope } from '../types.js';
import { CommentInput } from './comment-input.js';
import { CommentsStrip, OverallCommentEditor } from './comments-pane.js';
import { DiffPane } from './diff-pane.js';
import { FileList } from './file-list.js';
import type { Action, FileContentsCacheKey, PendingComment, State } from './state.js';
import {
  buildContentsCacheKey,
  createInitialState,
  getActiveFiles,
  getSelectedFile,
  Layout,
  Mode,
  Pane,
  reducer,
} from './state.js';
import { SubmitConfirm } from './submit-confirm.js';

//#region Constants

const SIDE_BY_SIDE_MIN_WIDTH = 1.2e2;
const SCOPE_ORDER: ReadonlyArray<ReviewScope> = [
  ReviewScope.Branch,
  ReviewScope.Commits,
  ReviewScope.All,
];

//#endregion

//#region Props

export interface DiffReviewModalProps {
  reviewData: ReviewWindowData;
  onSubmit: (prompt: string) => void;
  onCancel: () => void;
}

//#endregion

//#region Helpers

function buildPendingForLine(args: { file: ReviewFile; state: State }): PendingComment {
  const { file, state } = args;
  const commit: ReviewCommitInfo | undefined =
    state.scope === ReviewScope.Commits && state.selectedCommitSha !== null
      ? state.reviewData.commits.find((c) => c.sha === state.selectedCommitSha)
      : undefined;
  return {
    fileId: file.id,
    scope: state.scope,
    commitSha: commit?.sha ?? null,
    commitShort: commit?.shortSha ?? null,
    commitKind: commit?.kind ?? null,
    side: CommentSide.File,
    startLine: null,
    endLine: null,
  };
}

function nextScope(current: ReviewScope, direction: 1 | -1): ReviewScope {
  const idx = SCOPE_ORDER.indexOf(current);
  const len = SCOPE_ORDER.length;
  const next = (idx + direction + len) % len;
  return SCOPE_ORDER[next] ?? current;
}

//#endregion

//#region Effects

interface AsyncDeps {
  state: State;
  dispatch: (action: Action) => void;
}

interface FetchFileContentsArgs {
  repoRoot: string;
  branchMergeBaseSha: string | null;
  file: ReviewFile;
  cacheKey: FileContentsCacheKey;
  cacheKeyStr: string;
  dispatch: (action: Action) => void;
  isCancelled: () => boolean;
}

async function fetchFileContents(args: FetchFileContentsArgs): Promise<void> {
  const { repoRoot, branchMergeBaseSha, file, cacheKey, cacheKeyStr, dispatch, isCancelled } = args;
  try {
    const contents = await loadReviewFileContents({
      repoRoot,
      file,
      scope: cacheKey.scope,
      commitSha: cacheKey.commitSha,
      branchMergeBaseSha,
    });
    if (isCancelled()) {
      return;
    }
    dispatch({
      type: 'load-file-contents-success',
      key: cacheKeyStr,
      contents,
    });
  } catch {
    if (isCancelled()) {
      return;
    }
    dispatch({
      type: 'load-file-contents-failure',
      key: cacheKeyStr,
    });
  }
}

interface FetchCommitFilesArgs {
  repoRoot: string;
  sha: string;
  dispatch: (action: Action) => void;
  isCancelled: () => boolean;
}

async function fetchCommitFiles(args: FetchCommitFilesArgs): Promise<void> {
  const { repoRoot, sha, dispatch, isCancelled } = args;
  try {
    const files = await getCommitFiles(repoRoot, sha);
    if (isCancelled()) {
      return;
    }
    dispatch({
      type: 'load-commit-files-success',
      sha,
      files,
    });
  } catch {
    if (isCancelled()) {
      return;
    }
    dispatch({
      type: 'load-commit-files-failure',
      sha,
    });
  }
}

function useFileContentsLoader(deps: AsyncDeps): void {
  const { state, dispatch } = deps;
  const file = getSelectedFile(state);
  const cacheKey: FileContentsCacheKey | null = file
    ? {
        scope: state.scope,
        commitSha: state.scope === ReviewScope.Commits ? state.selectedCommitSha : null,
        fileId: file.id,
      }
    : null;
  const cacheKeyStr = cacheKey ? buildContentsCacheKey(cacheKey) : null;
  // Only the cacheKey *string* is in the dep array — `cacheKey` and `file` are
  // fresh objects each render, and dispatching load-start would otherwise
  // cancel our own in-flight fetch through the effect cleanup.
  //
  // Invariant: `stateRef.current` at effect-fire time matches the render that
  // produced `cacheKeyStr`. Holds because the assignment runs synchronously on
  // every render before its passive effects flush, and `useReducer` actions
  // are atomic — no batched state update can split scope/selectedFileId
  // across the cacheKeyStr derivation and the effect body.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (cacheKeyStr === null) {
      return;
    }
    const snap = stateRef.current;
    if (snap.fileContents.has(cacheKeyStr) || snap.loadingFileKeys.has(cacheKeyStr)) {
      return;
    }
    const currentFile = getSelectedFile(snap);
    if (!currentFile) {
      return;
    }
    const currentKey: FileContentsCacheKey = {
      scope: snap.scope,
      commitSha: snap.scope === ReviewScope.Commits ? snap.selectedCommitSha : null,
      fileId: currentFile.id,
    };
    let cancelled = false;
    dispatch({
      type: 'load-file-contents-start',
      key: cacheKeyStr,
    });
    void fetchFileContents({
      repoRoot: snap.reviewData.repoRoot,
      branchMergeBaseSha: snap.reviewData.branchMergeBaseSha,
      file: currentFile,
      cacheKey: currentKey,
      cacheKeyStr,
      dispatch,
      isCancelled: () => cancelled,
    });
    return () => {
      cancelled = true;
    };
  }, [
    cacheKeyStr,
    dispatch,
  ]);
}

function useCommitFilesLoader(deps: AsyncDeps): void {
  const { state, dispatch } = deps;
  const sha =
    state.scope === ReviewScope.Commits && state.selectedCommitSha !== null
      ? state.selectedCommitSha
      : null;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (sha === null) {
      return;
    }
    const snap = stateRef.current;
    if (snap.commitFiles.has(sha) || snap.loadingCommitShas.has(sha)) {
      return;
    }
    let cancelled = false;
    dispatch({
      type: 'load-commit-files-start',
      sha,
    });
    void fetchCommitFiles({
      repoRoot: snap.reviewData.repoRoot,
      sha,
      dispatch,
      isCancelled: () => cancelled,
    });
    return () => {
      cancelled = true;
    };
  }, [
    sha,
    dispatch,
  ]);
}

//#endregion

//#region Keymap

interface KeymapDeps {
  state: State;
  dispatch: (action: Action) => void;
  onCancel: () => void;
  onConfirmSubmit: () => void;
  visibleListLength: number;
  visibleDiffLength: number;
  terminalWidth: number;
}

function useBrowseKeymap(deps: KeymapDeps): void {
  const {
    state,
    dispatch,
    onCancel,
    onConfirmSubmit,
    visibleListLength,
    visibleDiffLength,
    terminalWidth,
  } = deps;

  useInput((input, key) => {
    if (state.mode !== Mode.Browse) {
      return;
    }
    // Clear any lingering toast on the next keypress.
    if (state.toast !== null) {
      dispatch({
        type: 'set-toast',
        toast: null,
      });
    }
    if (key.escape || (input === 'q' && !key.shift)) {
      onCancel();
      return;
    }
    if (key.tab && key.shift) {
      dispatch({
        type: 'set-scope',
        scope: nextScope(state.scope, -1),
      });
      return;
    }
    if (key.tab) {
      dispatch({
        type: 'set-scope',
        scope: nextScope(state.scope, 1),
      });
      return;
    }
    if (key.leftArrow || input === 'h') {
      dispatch({
        type: 'set-active-pane',
        pane: Pane.Files,
      });
      return;
    }
    if (key.rightArrow || input === 'l') {
      dispatch({
        type: 'set-active-pane',
        pane: Pane.Diff,
      });
      return;
    }
    const isUp = key.upArrow || input === 'k';
    const isDown = key.downArrow || input === 'j';
    if (isUp || isDown) {
      const len = state.activePane === Pane.Files ? visibleListLength : visibleDiffLength;
      if (len <= 0) {
        return;
      }
      const delta = isDown ? 1 : -1;
      const next = Math.max(0, Math.min(len - 1, state.cursorIndex + delta));
      dispatch({
        type: 'set-cursor-index',
        index: next,
      });
      if (state.activePane === Pane.Files) {
        applyFileListSelection({
          state,
          dispatch,
          cursorIndex: next,
        });
      }
      return;
    }
    if (key.return && state.activePane === Pane.Files) {
      handleListEnter({
        state,
        dispatch,
      });
      return;
    }
    if (input === 'c') {
      handleAddComment({
        state,
        dispatch,
      });
      return;
    }
    if (input === 'O') {
      dispatch({
        type: 'set-mode',
        mode: Mode.Overall,
      });
      return;
    }
    if (input === 'L') {
      handleToggleLayout({
        state,
        dispatch,
        terminalWidth,
      });
      return;
    }
    if (input === 'd') {
      handleDeleteFirstCommentOnLine({
        state,
        dispatch,
      });
      return;
    }
    if (input === 's') {
      onConfirmSubmit();
      return;
    }
  });
}

interface KeyHandlerArgs {
  state: State;
  dispatch: (action: Action) => void;
}

function applyFileListSelection(
  args: KeyHandlerArgs & {
    cursorIndex: number;
  },
): void {
  const { state, dispatch, cursorIndex } = args;
  if (state.scope === ReviewScope.Commits && state.selectedCommitSha === null) {
    // Commit-level cursor: selection is committed on Enter via handleListEnter, not on cursor move.
    return;
  }
  const files = getActiveFiles(state);
  const file = files[cursorIndex];
  if (file !== undefined) {
    dispatch({
      type: 'select-file',
      fileId: file.id,
    });
  }
}

function handleListEnter(args: KeyHandlerArgs): void {
  const { state, dispatch } = args;
  if (state.scope === ReviewScope.Commits && state.selectedCommitSha === null) {
    const commit = state.reviewData.commits[state.cursorIndex];
    if (commit !== undefined) {
      dispatch({
        type: 'select-commit',
        sha: commit.sha,
      });
    }
    return;
  }
  // For non-commits scope, Enter just confirms selection (already applied on cursor move).
}

function handleAddComment(args: KeyHandlerArgs): void {
  const { state, dispatch } = args;
  const file = getSelectedFile(state);
  if (file === undefined) {
    return;
  }
  const pending = buildPendingForLine({
    file,
    state,
  });
  dispatch({
    type: 'open-comment-input',
    pending,
  });
}

function handleToggleLayout(
  args: KeyHandlerArgs & {
    terminalWidth: number;
  },
): void {
  const { state, dispatch, terminalWidth } = args;
  if (state.layout === Layout.Unified) {
    if (terminalWidth < SIDE_BY_SIDE_MIN_WIDTH) {
      dispatch({
        type: 'set-toast',
        toast: `Side-by-side needs ≥${SIDE_BY_SIDE_MIN_WIDTH} cols (this terminal is ${terminalWidth}).`,
      });
      return;
    }
    dispatch({
      type: 'set-layout',
      layout: Layout.SideBySide,
    });
    return;
  }
  dispatch({
    type: 'set-layout',
    layout: Layout.Unified,
  });
}

function handleDeleteFirstCommentOnLine(args: KeyHandlerArgs): void {
  const { state, dispatch } = args;
  const file = getSelectedFile(state);
  if (file === undefined) {
    return;
  }
  const target = state.comments.find((c) => c.fileId === file.id);
  if (target === undefined) {
    return;
  }
  dispatch({
    type: 'delete-comment',
    commentId: target.id,
  });
}

//#endregion

//#region Component

export function DiffReviewModal({
  reviewData,
  onSubmit,
  onCancel,
}: DiffReviewModalProps): ReactNode {
  const theme = useTheme();
  const [state, dispatch] = useReducer(reducer, reviewData, createInitialState);
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 80;
  const terminalHeight = stdout?.rows ?? 24;

  useFileContentsLoader({
    state,
    dispatch,
  });
  useCommitFilesLoader({
    state,
    dispatch,
  });

  const file = getSelectedFile(state);
  const cacheKey =
    file !== undefined
      ? buildContentsCacheKey({
          scope: state.scope,
          commitSha: state.scope === ReviewScope.Commits ? state.selectedCommitSha : null,
          fileId: file.id,
        })
      : null;
  const contents = cacheKey !== null ? state.fileContents.get(cacheKey) : undefined;

  const visibleListLength = useMemo(() => {
    if (state.scope === ReviewScope.Commits && state.selectedCommitSha === null) {
      return state.reviewData.commits.length;
    }
    return getActiveFiles(state).length;
  }, [
    state,
  ]);

  // Diff line count is only used to clamp the cursor; we approximate as content
  // length. The DiffPane handles its own scroll window.
  const visibleDiffLength = contents
    ? Math.max(
        contents.originalContent.split('\n').length,
        contents.modifiedContent.split('\n').length,
      )
    : 0;

  const handleConfirmSubmit = useCallback((): void => {
    if (state.comments.length === 0 && state.overallComment.trim().length === 0) {
      dispatch({
        type: 'set-toast',
        toast: 'Add a comment or overall feedback before sending.',
      });
      return;
    }
    dispatch({
      type: 'set-mode',
      mode: Mode.SubmitConfirm,
    });
  }, [
    state.comments.length,
    state.overallComment,
  ]);

  useBrowseKeymap({
    state,
    dispatch,
    onCancel,
    onConfirmSubmit: handleConfirmSubmit,
    visibleListLength,
    visibleDiffLength,
    terminalWidth,
  });

  // Sub-modal: comment input
  if (state.mode === Mode.Comment && state.pendingComment !== null && file !== undefined) {
    const pending = state.pendingComment;
    return (
      <CommentInput
        pending={pending}
        file={file}
        onSubmit={(body: string) => {
          const comment: DiffReviewComment = {
            id: crypto.randomUUID(),
            fileId: pending.fileId,
            scope: pending.scope,
            commitSha: pending.commitSha,
            commitShort: pending.commitShort,
            commitKind: pending.commitKind,
            side: pending.side,
            startLine: pending.startLine,
            endLine: pending.endLine,
            body,
          };
          dispatch({
            type: 'submit-comment',
            comment,
          });
        }}
        onCancel={() =>
          dispatch({
            type: 'set-mode',
            mode: Mode.Browse,
          })
        }
      />
    );
  }

  // Sub-modal: overall editor
  if (state.mode === Mode.Overall) {
    return (
      <OverallCommentEditor
        initial={state.overallComment}
        onSubmit={(value: string) => {
          dispatch({
            type: 'set-overall',
            value,
          });
          dispatch({
            type: 'set-mode',
            mode: Mode.Browse,
          });
        }}
        onCancel={() =>
          dispatch({
            type: 'set-mode',
            mode: Mode.Browse,
          })
        }
      />
    );
  }

  // Sub-modal: submit confirm
  if (state.mode === Mode.SubmitConfirm) {
    const allFiles = collectAllFiles(state);
    const composed = composeReviewPrompt(allFiles, {
      type: 'submit',
      overallComment: state.overallComment,
      comments: state.comments,
    });
    return (
      <SubmitConfirm
        prompt={composed}
        onConfirm={() => onSubmit(composed)}
        onCancel={() =>
          dispatch({
            type: 'set-mode',
            mode: Mode.Browse,
          })
        }
      />
    );
  }

  // Browse layout
  const fileListWidth = Math.max(24, Math.floor(terminalWidth * 0.3));
  const diffWidth = terminalWidth - fileListWidth - 2;
  const diffHeight = Math.max(8, terminalHeight - 8);

  return (
    <Box
      flexDirection="column"
      width={terminalWidth}
      borderStyle="round"
      borderColor={theme.primary}
    >
      <Header state={state} />
      <Box flexDirection="row">
        <FileList state={state} width={fileListWidth} />
        <DiffPane
          state={state}
          file={file}
          contents={contents}
          width={diffWidth}
          height={diffHeight}
        />
      </Box>
      <CommentsStrip commentCount={state.comments.length} overallComment={state.overallComment} />
      {state.toast !== null ? (
        <Box paddingX={1}>
          <Text color={theme.warning}>{state.toast}</Text>
        </Box>
      ) : null}
      <Footer />
    </Box>
  );
}

//#endregion

//#region Header / footer

interface HeaderProps {
  state: State;
}

function Header({ state }: HeaderProps): ReactNode {
  const theme = useTheme();
  const labelFor = (scope: ReviewScope): string => {
    if (scope === ReviewScope.Branch) {
      return 'Branch';
    }
    if (scope === ReviewScope.Commits) {
      return 'Commits';
    }
    return 'All';
  };
  const baseRef = state.reviewData.branchBaseRef ?? '(no base)';
  return (
    <Box paddingX={1} flexDirection="row">
      <Text bold color={theme.primary}>
        diff review{' '}
      </Text>
      {SCOPE_ORDER.map((scope) => {
        const isActive = state.scope === scope;
        return (
          <Text key={scope} color={isActive ? theme.accent : theme.muted} bold={isActive}>
            [{labelFor(scope)}]{' '}
          </Text>
        );
      })}
      <Text dimColor> base: {baseRef}</Text>
    </Box>
  );
}

function Footer(): ReactNode {
  return (
    <Box paddingX={1}>
      <Text dimColor>
        ↑↓ nav · ←→ pane · Tab scope · Enter open · c comment · O overall · L layout · s submit · q
        cancel
      </Text>
    </Box>
  );
}

//#endregion

//#region Helpers (post)

function collectAllFiles(state: State): ReadonlyArray<ReviewFile> {
  const seen = new Map<string, ReviewFile>();
  for (const f of state.reviewData.files) {
    seen.set(f.id, f);
  }
  for (const list of state.commitFiles.values()) {
    for (const f of list) {
      seen.set(f.id, f);
    }
  }
  return [
    ...seen.values(),
  ];
}

//#endregion
