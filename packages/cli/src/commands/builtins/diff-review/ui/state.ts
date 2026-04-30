/**
 * Pure reducer for the diff-review modal.
 *
 * The pi extension's web UI tracked all of this in imperative TS + DOM mutation.
 * In Ink we run it through `useReducer` so all transitions are testable in
 * isolation and async fetches stay outside the reducer.
 *
 * Cache invalidation in `RefreshReviewData` mirrors upstream's
 * `clearRefreshableCaches` (drop content cache, drop working-tree commit-files
 * cache).
 */

import { isWorkingTreeCommitSha } from '../git.js';
import type {
  CommentSide,
  DiffReviewComment,
  ReviewCommitKind,
  ReviewFile,
  ReviewFileContents,
  ReviewWindowData,
} from '../types.js';
import { ReviewScope } from '../types.js';

//#region Mode + Layout

export const Mode = {
  Browse: 'browse',
  Comment: 'comment',
  Overall: 'overall',
  SubmitConfirm: 'submit-confirm',
} as const;

export type Mode = (typeof Mode)[keyof typeof Mode];

export const Layout = {
  Unified: 'unified',
  SideBySide: 'side-by-side',
} as const;

export type Layout = (typeof Layout)[keyof typeof Layout];

export const Pane = {
  Files: 'files',
  Diff: 'diff',
} as const;

export type Pane = (typeof Pane)[keyof typeof Pane];

//#endregion

//#region State

export interface PendingComment {
  fileId: string;
  scope: ReviewScope;
  commitSha: string | null;
  commitShort: string | null;
  commitKind: ReviewCommitKind | null;
  side: CommentSide;
  startLine: number | null;
  endLine: number | null;
}

export interface FileContentsCacheKey {
  scope: ReviewScope;
  commitSha: string | null;
  fileId: string;
}

export function buildContentsCacheKey(key: FileContentsCacheKey): string {
  return `${key.scope}:${key.commitSha ?? ''}:${key.fileId}`;
}

export interface State {
  scope: ReviewScope;
  selectedCommitSha: string | null;
  selectedFileId: string | null;
  activePane: Pane;
  cursorIndex: number;
  layout: Layout;
  mode: Mode;
  comments: DiffReviewComment[];
  overallComment: string;
  pendingComment: PendingComment | null;
  reviewData: ReviewWindowData;
  fileContents: ReadonlyMap<string, ReviewFileContents>;
  commitFiles: ReadonlyMap<string, ReadonlyArray<ReviewFile>>;
  loadingFileKeys: ReadonlySet<string>;
  loadingCommitShas: ReadonlySet<string>;
  toast: string | null;
}

export function createInitialState(reviewData: ReviewWindowData): State {
  const firstFile = reviewData.files[0];
  return {
    scope: ReviewScope.Branch,
    selectedCommitSha: null,
    selectedFileId: firstFile?.id ?? null,
    activePane: Pane.Files,
    cursorIndex: 0,
    layout: Layout.Unified,
    mode: Mode.Browse,
    comments: [],
    overallComment: '',
    pendingComment: null,
    reviewData,
    fileContents: new Map(),
    commitFiles: new Map(),
    loadingFileKeys: new Set(),
    loadingCommitShas: new Set(),
    toast: null,
  };
}

//#endregion

//#region Action union

export type Action =
  | {
      type: 'set-scope';
      scope: ReviewScope;
    }
  | {
      type: 'select-commit';
      sha: string;
    }
  | {
      type: 'select-file';
      fileId: string;
    }
  | {
      type: 'set-active-pane';
      pane: Pane;
    }
  | {
      type: 'set-cursor-index';
      index: number;
    }
  | {
      type: 'set-layout';
      layout: Layout;
    }
  | {
      type: 'set-mode';
      mode: Mode;
    }
  | {
      type: 'open-comment-input';
      pending: PendingComment;
    }
  | {
      type: 'submit-comment';
      comment: DiffReviewComment;
    }
  | {
      type: 'delete-comment';
      commentId: string;
    }
  | {
      type: 'set-overall';
      value: string;
    }
  | {
      type: 'load-file-contents-start';
      key: string;
    }
  | {
      type: 'load-file-contents-success';
      key: string;
      contents: ReviewFileContents;
    }
  | {
      type: 'load-file-contents-failure';
      key: string;
    }
  | {
      type: 'load-commit-files-start';
      sha: string;
    }
  | {
      type: 'load-commit-files-success';
      sha: string;
      files: ReadonlyArray<ReviewFile>;
    }
  | {
      type: 'load-commit-files-failure';
      sha: string;
    }
  | {
      type: 'refresh-review-data';
      reviewData: ReviewWindowData;
    }
  | {
      type: 'set-toast';
      toast: string | null;
    };

//#endregion

//#region Reducer

function dropWorkingTreeCommitEntries(
  commitFiles: ReadonlyMap<string, ReadonlyArray<ReviewFile>>,
): ReadonlyMap<string, ReadonlyArray<ReviewFile>> {
  const next = new Map<string, ReadonlyArray<ReviewFile>>();
  for (const [sha, files] of commitFiles) {
    if (isWorkingTreeCommitSha(sha)) {
      continue;
    }
    next.set(sha, files);
  }
  return next;
}

function withSet<T>(set: ReadonlySet<T>, value: T, present: boolean): ReadonlySet<T> {
  const next = new Set(set);
  if (present) {
    next.add(value);
  } else {
    next.delete(value);
  }
  return next;
}

function withMap<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

export function reducer(state: State, action: Action): State {
  if (action.type === 'set-scope') {
    if (action.scope === state.scope) {
      return state;
    }
    return {
      ...state,
      scope: action.scope,
      selectedCommitSha: null,
      selectedFileId:
        action.scope === ReviewScope.Commits ? null : (state.reviewData.files[0]?.id ?? null),
      activePane: Pane.Files,
      cursorIndex: 0,
    };
  }

  if (action.type === 'select-commit') {
    return {
      ...state,
      selectedCommitSha: action.sha,
      selectedFileId: null,
      cursorIndex: 0,
    };
  }

  if (action.type === 'select-file') {
    if (action.fileId === state.selectedFileId) {
      return state;
    }
    return {
      ...state,
      selectedFileId: action.fileId,
    };
  }

  if (action.type === 'set-active-pane') {
    if (action.pane === state.activePane) {
      return state;
    }
    return {
      ...state,
      activePane: action.pane,
    };
  }

  if (action.type === 'set-cursor-index') {
    if (action.index < 0 || action.index === state.cursorIndex) {
      return state;
    }
    return {
      ...state,
      cursorIndex: action.index,
    };
  }

  if (action.type === 'set-layout') {
    if (action.layout === state.layout) {
      return state;
    }
    return {
      ...state,
      layout: action.layout,
    };
  }

  if (action.type === 'set-mode') {
    if (action.mode === state.mode) {
      return state;
    }
    return {
      ...state,
      mode: action.mode,
    };
  }

  if (action.type === 'open-comment-input') {
    return {
      ...state,
      mode: Mode.Comment,
      pendingComment: action.pending,
    };
  }

  if (action.type === 'submit-comment') {
    return {
      ...state,
      comments: [
        ...state.comments,
        action.comment,
      ],
      pendingComment: null,
      mode: Mode.Browse,
    };
  }

  if (action.type === 'delete-comment') {
    return {
      ...state,
      comments: state.comments.filter((c) => c.id !== action.commentId),
    };
  }

  if (action.type === 'set-overall') {
    if (action.value === state.overallComment) {
      return state;
    }
    return {
      ...state,
      overallComment: action.value,
    };
  }

  if (action.type === 'load-file-contents-start') {
    return {
      ...state,
      loadingFileKeys: withSet(state.loadingFileKeys, action.key, true),
    };
  }

  if (action.type === 'load-file-contents-success') {
    return {
      ...state,
      fileContents: withMap(state.fileContents, action.key, action.contents),
      loadingFileKeys: withSet(state.loadingFileKeys, action.key, false),
    };
  }

  if (action.type === 'load-file-contents-failure') {
    return {
      ...state,
      loadingFileKeys: withSet(state.loadingFileKeys, action.key, false),
    };
  }

  if (action.type === 'load-commit-files-start') {
    return {
      ...state,
      loadingCommitShas: withSet(state.loadingCommitShas, action.sha, true),
    };
  }

  if (action.type === 'load-commit-files-success') {
    return {
      ...state,
      commitFiles: withMap(state.commitFiles, action.sha, action.files),
      loadingCommitShas: withSet(state.loadingCommitShas, action.sha, false),
    };
  }

  if (action.type === 'load-commit-files-failure') {
    return {
      ...state,
      loadingCommitShas: withSet(state.loadingCommitShas, action.sha, false),
    };
  }

  if (action.type === 'refresh-review-data') {
    return {
      ...state,
      reviewData: action.reviewData,
      fileContents: new Map(),
      commitFiles: dropWorkingTreeCommitEntries(state.commitFiles),
    };
  }

  if (action.type === 'set-toast') {
    if (action.toast === state.toast) {
      return state;
    }
    return {
      ...state,
      toast: action.toast,
    };
  }

  const _exhaustive: never = action;
  return _exhaustive;
}

//#endregion

//#region Selectors

export function getActiveFiles(state: State): ReadonlyArray<ReviewFile> {
  if (state.scope !== ReviewScope.Commits) {
    return state.reviewData.files;
  }
  if (state.selectedCommitSha === null) {
    return [];
  }
  return state.commitFiles.get(state.selectedCommitSha) ?? [];
}

export function getSelectedFile(state: State): ReviewFile | undefined {
  const files = getActiveFiles(state);
  if (state.selectedFileId === null) {
    return files[0];
  }
  return files.find((f) => f.id === state.selectedFileId);
}

//#endregion
