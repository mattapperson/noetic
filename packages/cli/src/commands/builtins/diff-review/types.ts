/**
 * Domain types for the /diff-review command.
 *
 * Ported from upstream `@ryan_nookpi/pi-extension-diff-review` `types.ts`
 * (https://github.com/Jonghakseo/pi-extension/blob/main/packages/diff-review/types.ts).
 *
 * The IPC message types from upstream (request/file-data/commit-data/error
 * variants) are intentionally omitted — those existed because the pi extension
 * ran the UI in a separate native window and exchanged JSON over stdio. In
 * the noetic CLI, the UI runs in-process so the same data flows through plain
 * function calls and React state.
 *
 * String-literal unions are expressed as `as const` objects per the project's
 * naming-conventions / type-safety rules.
 */

//#region String enums

export const ReviewScope = {
  Branch: 'branch',
  Commits: 'commits',
  All: 'all',
} as const;

export type ReviewScope = (typeof ReviewScope)[keyof typeof ReviewScope];

export const ChangeStatus = {
  Modified: 'modified',
  Added: 'added',
  Deleted: 'deleted',
  Renamed: 'renamed',
} as const;

export type ChangeStatus = (typeof ChangeStatus)[keyof typeof ChangeStatus];

export const ReviewFileKind = {
  Text: 'text',
  Binary: 'binary',
  Image: 'image',
} as const;

export type ReviewFileKind = (typeof ReviewFileKind)[keyof typeof ReviewFileKind];

export const ReviewCommitKind = {
  Commit: 'commit',
  WorkingTree: 'working-tree',
} as const;

export type ReviewCommitKind = (typeof ReviewCommitKind)[keyof typeof ReviewCommitKind];

export const CommentSide = {
  Original: 'original',
  Modified: 'modified',
  File: 'file',
} as const;

export type CommentSide = (typeof CommentSide)[keyof typeof CommentSide];

//#endregion

//#region Review data shapes

export interface ReviewFileComparison {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  hasOriginal: boolean;
  hasModified: boolean;
}

export interface ReviewFile {
  id: string;
  path: string;
  worktreeStatus: ChangeStatus | null;
  hasWorkingTreeFile: boolean;
  /** True when the file is touched by the current branch diff (merge-base/base ref vs HEAD). */
  inGitDiff: boolean;
  /** Diff comparison to render for the file in the current scope.
   *  - branch scope: merge-base/base ref vs HEAD
   *  - commits scope: commit vs commit^ (populated when loaded via getCommitFiles) */
  gitDiff: ReviewFileComparison | null;
  kind: ReviewFileKind;
  mimeType: string | null;
}

export interface ReviewCommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorDate: string;
  kind: ReviewCommitKind;
}

export interface ReviewFileContents {
  originalContent: string;
  modifiedContent: string;
  kind: ReviewFileKind;
  mimeType: string | null;
  originalExists: boolean;
  modifiedExists: boolean;
  /** Always null in the terminal port — kept for type parity with upstream. */
  originalPreviewUrl: string | null;
  /** Always null in the terminal port — kept for type parity with upstream. */
  modifiedPreviewUrl: string | null;
}

export interface DiffReviewComment {
  id: string;
  fileId: string;
  scope: ReviewScope;
  /** Commit SHA when scope === ReviewScope.Commits. */
  commitSha?: string | null;
  /** Short commit identifier to render in the prompt (e.g. first 7 chars of SHA). */
  commitShort?: string | null;
  commitKind?: ReviewCommitKind | null;
  side: CommentSide;
  startLine: number | null;
  endLine: number | null;
  body: string;
}

export interface ReviewSubmitPayload {
  type: 'submit';
  overallComment: string;
  comments: DiffReviewComment[];
}

export interface ReviewWindowData {
  repoRoot: string;
  files: ReviewFile[];
  commits: ReviewCommitInfo[];
  branchBaseRef: string | null;
  branchMergeBaseSha: string | null;
  repositoryHasHead: boolean;
}

//#endregion
