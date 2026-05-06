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

import { isWorkingTreeCommitSha } from '../../../commands/builtins/diff-review/git.js';
import type {
  CommentSide,
  DiffReviewComment,
  ReviewCommitKind,
  ReviewFile,
  ReviewFileContents,
  ReviewWindowData,
} from '../../../commands/builtins/diff-review/types.js';
import { ReviewScope } from '../../../commands/builtins/diff-review/types.js';

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

type ScopeAction = Extract<Action, { type: 'set-scope' }>;
type CommitAction = Extract<Action, { type: 'select-commit' }>;
type FileAction = Extract<Action, { type: 'select-file' }>;
type PaneAction = Extract<Action, { type: 'set-active-pane' }>;
type CursorAction = Extract<Action, { type: 'set-cursor-index' }>;
type LayoutAction = Extract<Action, { type: 'set-layout' }>;
type ModeAction = Extract<Action, { type: 'set-mode' }>;
type OpenCommentAction = Extract<Action, { type: 'open-comment-input' }>;
type SubmitCommentAction = Extract<Action, { type: 'submit-comment' }>;
type DeleteCommentAction = Extract<Action, { type: 'delete-comment' }>;
type OverallAction = Extract<Action, { type: 'set-overall' }>;
type FileLoadAction = Extract<
  Action,
  | { type: 'load-file-contents-start' }
  | { type: 'load-file-contents-success' }
  | { type: 'load-file-contents-failure' }
>;
type CommitLoadAction = Extract<
  Action,
  | { type: 'load-commit-files-start' }
  | { type: 'load-commit-files-success' }
  | { type: 'load-commit-files-failure' }
>;
type RefreshAction = Extract<Action, { type: 'refresh-review-data' }>;
type ToastAction = Extract<Action, { type: 'set-toast' }>;

function reduceScope(state: State, action: ScopeAction): State {
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

function reduceSelection(state: State, action: ScopeAction | CommitAction | FileAction): State {
  if (action.type === 'set-scope') {
    return reduceScope(state, action);
  }
  if (action.type === 'select-commit') {
    return {
      ...state,
      selectedCommitSha: action.sha,
      selectedFileId: null,
      cursorIndex: 0,
    };
  }
  if (action.fileId === state.selectedFileId) {
    return state;
  }
  return {
    ...state,
    selectedFileId: action.fileId,
  };
}

function reduceView(state: State, action: PaneAction | CursorAction | LayoutAction | ModeAction): State {
  if (action.type === 'set-active-pane') {
    return action.pane === state.activePane ? state : { ...state, activePane: action.pane };
  }
  if (action.type === 'set-cursor-index') {
    return action.index < 0 || action.index === state.cursorIndex
      ? state
      : { ...state, cursorIndex: action.index };
  }
  if (action.type === 'set-layout') {
    return action.layout === state.layout ? state : { ...state, layout: action.layout };
  }
  return action.mode === state.mode ? state : { ...state, mode: action.mode };
}

function reduceComments(
  state: State,
  action: OpenCommentAction | SubmitCommentAction | DeleteCommentAction | OverallAction,
): State {
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
  return action.value === state.overallComment ? state : { ...state, overallComment: action.value };
}

function reduceFileLoading(state: State, action: FileLoadAction): State {
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
  return {
    ...state,
    loadingFileKeys: withSet(state.loadingFileKeys, action.key, false),
  };
}

function reduceCommitLoading(state: State, action: CommitLoadAction): State {
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
  return {
    ...state,
    loadingCommitShas: withSet(state.loadingCommitShas, action.sha, false),
  };
}

function reduceRefresh(state: State, action: RefreshAction): State {
  return {
    ...state,
    reviewData: action.reviewData,
    fileContents: new Map(),
    commitFiles: dropWorkingTreeCommitEntries(state.commitFiles),
  };
}

function reduceToast(state: State, action: ToastAction): State {
  return action.toast === state.toast ? state : { ...state, toast: action.toast };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'set-scope':
    case 'select-commit':
    case 'select-file':
      return reduceSelection(state, action);
    case 'set-active-pane':
    case 'set-cursor-index':
    case 'set-layout':
    case 'set-mode':
      return reduceView(state, action);
    case 'open-comment-input':
    case 'submit-comment':
    case 'delete-comment':
    case 'set-overall':
      return reduceComments(state, action);
    case 'load-file-contents-start':
    case 'load-file-contents-success':
    case 'load-file-contents-failure':
      return reduceFileLoading(state, action);
    case 'load-commit-files-start':
    case 'load-commit-files-success':
    case 'load-commit-files-failure':
      return reduceCommitLoading(state, action);
    case 'refresh-review-data':
      return reduceRefresh(state, action);
    case 'set-toast':
      return reduceToast(state, action);
  }
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
