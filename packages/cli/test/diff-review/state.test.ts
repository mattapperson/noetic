/**
 * Reducer transition tests.
 *
 * The reducer is pure, so each test asserts that a single action moves state
 * from a known input to a known output. Async fetch wiring is exercised at
 * the modal level, not here.
 */

import { describe, expect, test } from 'bun:test';
import type {
  DiffReviewComment,
  ReviewFile,
  ReviewWindowData,
} from '../../src/commands/builtins/diff-review/types.js';
import {
  ChangeStatus,
  CommentSide,
  ReviewCommitKind,
  ReviewFileKind,
  ReviewScope,
} from '../../src/commands/builtins/diff-review/types.js';
import {
  buildContentsCacheKey,
  createInitialState,
  Layout,
  Mode,
  Pane,
  reducer,
} from '../../src/tui/commands/diff-review-ui/state.js';

function file(id: string, path: string): ReviewFile {
  return {
    id,
    path,
    worktreeStatus: ChangeStatus.Modified,
    hasWorkingTreeFile: true,
    inGitDiff: true,
    gitDiff: {
      status: ChangeStatus.Modified,
      oldPath: path,
      newPath: path,
      displayPath: path,
      hasOriginal: true,
      hasModified: true,
    },
    kind: ReviewFileKind.Text,
    mimeType: null,
  };
}

function makeReviewData(): ReviewWindowData {
  return {
    repoRoot: '/repo',
    files: [
      file('f1', 'src/a.ts'),
      file('f2', 'src/b.ts'),
    ],
    commits: [
      {
        sha: 'sha-working',
        shortSha: 'WT',
        subject: 'Uncommitted changes',
        authorName: '',
        authorDate: '',
        kind: ReviewCommitKind.WorkingTree,
      },
      {
        sha: 'abc1234',
        shortSha: 'abc1234',
        subject: 'fix: thing',
        authorName: 'me',
        authorDate: '2025-01-01',
        kind: ReviewCommitKind.Commit,
      },
    ],
    branchBaseRef: 'origin/main',
    branchMergeBaseSha: 'mb1234',
    repositoryHasHead: true,
  };
}

describe('createInitialState', () => {
  test('selects the first file when one exists', () => {
    const s = createInitialState(makeReviewData());
    expect(s.scope).toBe(ReviewScope.Branch);
    expect(s.selectedFileId).toBe('f1');
    expect(s.activePane).toBe(Pane.Files);
    expect(s.layout).toBe(Layout.Unified);
    expect(s.mode).toBe(Mode.Browse);
    expect(s.cursorIndex).toBe(0);
  });
});

describe('reducer transitions', () => {
  test('set-scope to Commits clears file selection', () => {
    const s0 = createInitialState(makeReviewData());
    const s1 = reducer(s0, {
      type: 'set-scope',
      scope: ReviewScope.Commits,
    });
    expect(s1.scope).toBe(ReviewScope.Commits);
    expect(s1.selectedFileId).toBeNull();
    expect(s1.selectedCommitSha).toBeNull();
    expect(s1.cursorIndex).toBe(0);
  });

  test('set-scope to All preserves file selection at first file', () => {
    const s0 = createInitialState(makeReviewData());
    const s1 = reducer(s0, {
      type: 'set-scope',
      scope: ReviewScope.All,
    });
    expect(s1.scope).toBe(ReviewScope.All);
    expect(s1.selectedFileId).toBe('f1');
  });

  test('select-commit sets sha and clears file selection', () => {
    const s0 = createInitialState(makeReviewData());
    const s1 = reducer(s0, {
      type: 'select-commit',
      sha: 'abc1234',
    });
    expect(s1.selectedCommitSha).toBe('abc1234');
    expect(s1.selectedFileId).toBeNull();
  });

  test('select-file updates selection without losing cursor', () => {
    const s0 = createInitialState(makeReviewData());
    const s1 = reducer(s0, {
      type: 'set-cursor-index',
      index: 1,
    });
    const s2 = reducer(s1, {
      type: 'select-file',
      fileId: 'f2',
    });
    expect(s2.selectedFileId).toBe('f2');
    expect(s2.cursorIndex).toBe(1);
  });

  test('set-cursor-index ignores negative values', () => {
    const s0 = createInitialState(makeReviewData());
    const s1 = reducer(s0, {
      type: 'set-cursor-index',
      index: -3,
    });
    expect(s1).toBe(s0);
  });

  test('set-active-pane swaps focus between files and diff', () => {
    const s0 = createInitialState(makeReviewData());
    const s1 = reducer(s0, {
      type: 'set-active-pane',
      pane: Pane.Diff,
    });
    expect(s1.activePane).toBe(Pane.Diff);
  });

  test('set-layout toggles between unified and side-by-side', () => {
    const s0 = createInitialState(makeReviewData());
    const s1 = reducer(s0, {
      type: 'set-layout',
      layout: Layout.SideBySide,
    });
    expect(s1.layout).toBe(Layout.SideBySide);
    const s2 = reducer(s1, {
      type: 'set-layout',
      layout: Layout.Unified,
    });
    expect(s2.layout).toBe(Layout.Unified);
  });

  test('open-comment-input enters comment mode with pending payload', () => {
    const s0 = createInitialState(makeReviewData());
    const s1 = reducer(s0, {
      type: 'open-comment-input',
      pending: {
        fileId: 'f1',
        scope: ReviewScope.Branch,
        commitSha: null,
        commitShort: null,
        commitKind: null,
        side: CommentSide.Modified,
        startLine: 12,
        endLine: 12,
      },
    });
    expect(s1.mode).toBe(Mode.Comment);
    expect(s1.pendingComment?.fileId).toBe('f1');
  });

  test('submit-comment appends comment, clears pending, returns to browse', () => {
    const s0 = createInitialState(makeReviewData());
    const comment: DiffReviewComment = {
      id: 'c1',
      fileId: 'f1',
      scope: ReviewScope.Branch,
      side: CommentSide.Modified,
      startLine: 12,
      endLine: 12,
      body: 'fix this',
    };
    const s1 = reducer(s0, {
      type: 'submit-comment',
      comment,
    });
    expect(s1.comments).toHaveLength(1);
    expect(s1.comments[0]?.id).toBe('c1');
    expect(s1.pendingComment).toBeNull();
    expect(s1.mode).toBe(Mode.Browse);
  });

  test('delete-comment removes the matching id', () => {
    const s0 = createInitialState(makeReviewData());
    const s1 = reducer(s0, {
      type: 'submit-comment',
      comment: {
        id: 'c1',
        fileId: 'f1',
        scope: ReviewScope.Branch,
        side: CommentSide.Modified,
        startLine: 1,
        endLine: 1,
        body: 'a',
      },
    });
    const s2 = reducer(s1, {
      type: 'submit-comment',
      comment: {
        id: 'c2',
        fileId: 'f1',
        scope: ReviewScope.Branch,
        side: CommentSide.Modified,
        startLine: 2,
        endLine: 2,
        body: 'b',
      },
    });
    const s3 = reducer(s2, {
      type: 'delete-comment',
      commentId: 'c1',
    });
    expect(s3.comments).toHaveLength(1);
    expect(s3.comments[0]?.id).toBe('c2');
  });

  test('set-overall stores the value', () => {
    const s0 = createInitialState(makeReviewData());
    const s1 = reducer(s0, {
      type: 'set-overall',
      value: 'overall feedback',
    });
    expect(s1.overallComment).toBe('overall feedback');
  });

  test('load-file-contents lifecycle: start → success', () => {
    const s0 = createInitialState(makeReviewData());
    const key = buildContentsCacheKey({
      scope: ReviewScope.Branch,
      commitSha: null,
      fileId: 'f1',
    });
    const s1 = reducer(s0, {
      type: 'load-file-contents-start',
      key,
    });
    expect(s1.loadingFileKeys.has(key)).toBe(true);

    const s2 = reducer(s1, {
      type: 'load-file-contents-success',
      key,
      contents: {
        originalContent: 'old',
        modifiedContent: 'new',
        kind: ReviewFileKind.Text,
        mimeType: null,
        originalExists: true,
        modifiedExists: true,
        originalPreviewUrl: null,
        modifiedPreviewUrl: null,
      },
    });
    expect(s2.loadingFileKeys.has(key)).toBe(false);
    expect(s2.fileContents.get(key)?.modifiedContent).toBe('new');
  });

  test('load-commit-files-success caches the file list', () => {
    const s0 = createInitialState(makeReviewData());
    const s1 = reducer(s0, {
      type: 'load-commit-files-success',
      sha: 'abc1234',
      files: [
        file('cf1', 'src/c.ts'),
      ],
    });
    expect(s1.commitFiles.get('abc1234')).toHaveLength(1);
  });

  test('refresh-review-data clears file contents and working-tree commit cache', () => {
    const s0 = createInitialState(makeReviewData());
    const branchKey = buildContentsCacheKey({
      scope: ReviewScope.Branch,
      commitSha: null,
      fileId: 'f1',
    });
    const s1 = reducer(s0, {
      type: 'load-file-contents-success',
      key: branchKey,
      contents: {
        originalContent: '',
        modifiedContent: '',
        kind: ReviewFileKind.Text,
        mimeType: null,
        originalExists: true,
        modifiedExists: true,
        originalPreviewUrl: null,
        modifiedPreviewUrl: null,
      },
    });
    const s2 = reducer(s1, {
      type: 'load-commit-files-success',
      sha: '__noetic_working_tree__',
      files: [],
    });
    const s3 = reducer(s2, {
      type: 'load-commit-files-success',
      sha: 'abc1234',
      files: [],
    });
    const s4 = reducer(s3, {
      type: 'refresh-review-data',
      reviewData: makeReviewData(),
    });
    expect(s4.fileContents.size).toBe(0);
    expect(s4.commitFiles.has('__noetic_working_tree__')).toBe(false);
    expect(s4.commitFiles.has('abc1234')).toBe(true);
  });

  test('set-toast stores and clears the toast string', () => {
    const s0 = createInitialState(makeReviewData());
    const s1 = reducer(s0, {
      type: 'set-toast',
      toast: 'hello',
    });
    expect(s1.toast).toBe('hello');
    const s2 = reducer(s1, {
      type: 'set-toast',
      toast: null,
    });
    expect(s2.toast).toBeNull();
  });
});
