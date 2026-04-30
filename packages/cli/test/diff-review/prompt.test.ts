/**
 * Tests for composeReviewPrompt — covers overall-only, line, file, range,
 * and per-scope label variants. Mirrors the upstream prompt layout so the
 * port stays a drop-in replacement.
 */

import { describe, expect, test } from 'bun:test';

import { composeReviewPrompt } from '../../src/commands/builtins/diff-review/prompt.js';
import type {
  DiffReviewComment,
  ReviewFile,
  ReviewSubmitPayload,
} from '../../src/commands/builtins/diff-review/types.js';
import {
  ChangeStatus,
  CommentSide,
  ReviewCommitKind,
  ReviewFileKind,
  ReviewScope,
} from '../../src/commands/builtins/diff-review/types.js';

function makeFile(id: string, path: string): ReviewFile {
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

function makeComment(
  overrides: Partial<DiffReviewComment> & {
    fileId: string;
  },
): DiffReviewComment {
  return {
    id: 'c1',
    scope: ReviewScope.Branch,
    side: CommentSide.Modified,
    startLine: 10,
    endLine: 10,
    body: 'test comment',
    ...overrides,
  };
}

describe('composeReviewPrompt', () => {
  test('overall-only payload renders just the overall comment', () => {
    const payload: ReviewSubmitPayload = {
      type: 'submit',
      overallComment: '  Overall feedback here.  ',
      comments: [],
    };
    const out = composeReviewPrompt([], payload);
    expect(out).toContain('Please address the following feedback');
    expect(out).toContain('Overall feedback here.');
  });

  test('line comment in branch scope adds (new) suffix', () => {
    const file = makeFile('f1', 'src/a.ts');
    const payload: ReviewSubmitPayload = {
      type: 'submit',
      overallComment: '',
      comments: [
        makeComment({
          fileId: 'f1',
          scope: ReviewScope.Branch,
          side: CommentSide.Modified,
          startLine: 12,
          endLine: 12,
          body: 'simplify this',
        }),
      ],
    };
    const out = composeReviewPrompt(
      [
        file,
      ],
      payload,
    );
    expect(out).toContain('[branch diff] src/a.ts:12 (new)');
    expect(out).toContain('simplify this');
  });

  test('range line comment renders start-end', () => {
    const file = makeFile('f1', 'src/a.ts');
    const payload: ReviewSubmitPayload = {
      type: 'submit',
      overallComment: '',
      comments: [
        makeComment({
          fileId: 'f1',
          scope: ReviewScope.Branch,
          side: CommentSide.Original,
          startLine: 10,
          endLine: 14,
          body: 'extract',
        }),
      ],
    };
    const out = composeReviewPrompt(
      [
        file,
      ],
      payload,
    );
    expect(out).toContain('[branch diff] src/a.ts:10-14 (old)');
  });

  test('file-level comment omits line numbers and side suffix', () => {
    const file = makeFile('f1', 'src/a.ts');
    const payload: ReviewSubmitPayload = {
      type: 'submit',
      overallComment: '',
      comments: [
        makeComment({
          fileId: 'f1',
          scope: ReviewScope.Branch,
          side: CommentSide.File,
          startLine: null,
          endLine: null,
          body: 'rename file',
        }),
      ],
    };
    const out = composeReviewPrompt(
      [
        file,
      ],
      payload,
    );
    expect(out).toContain('[branch diff] src/a.ts');
    expect(out).not.toContain(':10');
    expect(out).not.toContain('(new)');
    expect(out).not.toContain('(old)');
  });

  test('commits scope renders short SHA', () => {
    const file = makeFile('f1', 'src/a.ts');
    const payload: ReviewSubmitPayload = {
      type: 'submit',
      overallComment: '',
      comments: [
        makeComment({
          fileId: 'f1',
          scope: ReviewScope.Commits,
          commitSha: 'abc1234deadbeef',
          commitShort: 'abc1234',
          commitKind: ReviewCommitKind.Commit,
          side: CommentSide.Modified,
          startLine: 5,
          endLine: 5,
        }),
      ],
    };
    const out = composeReviewPrompt(
      [
        file,
      ],
      payload,
    );
    expect(out).toContain('[commit abc1234] src/a.ts:5 (new)');
  });

  test('working-tree commit renders working-tree label', () => {
    const file = makeFile('f1', 'src/a.ts');
    const payload: ReviewSubmitPayload = {
      type: 'submit',
      overallComment: '',
      comments: [
        makeComment({
          fileId: 'f1',
          scope: ReviewScope.Commits,
          commitSha: '__noetic_working_tree__',
          commitKind: ReviewCommitKind.WorkingTree,
          side: CommentSide.Modified,
          startLine: 1,
          endLine: 1,
        }),
      ],
    };
    const out = composeReviewPrompt(
      [
        file,
      ],
      payload,
    );
    expect(out).toContain('[working tree changes] src/a.ts:1 (new)');
  });

  test('all-files scope omits side suffix even on line comments', () => {
    const file = makeFile('f1', 'src/a.ts');
    const payload: ReviewSubmitPayload = {
      type: 'submit',
      overallComment: '',
      comments: [
        makeComment({
          fileId: 'f1',
          scope: ReviewScope.All,
          side: CommentSide.Modified,
          startLine: 7,
          endLine: 7,
        }),
      ],
    };
    const out = composeReviewPrompt(
      [
        file,
      ],
      payload,
    );
    expect(out).toContain('[all files] src/a.ts:7');
    expect(out).not.toContain('(new)');
  });

  test('unknown fileId falls back to "(unknown file)" label', () => {
    const payload: ReviewSubmitPayload = {
      type: 'submit',
      overallComment: '',
      comments: [
        makeComment({
          fileId: 'missing',
          body: 'orphan comment',
        }),
      ],
    };
    const out = composeReviewPrompt([], payload);
    expect(out).toContain('(unknown file)');
    expect(out).toContain('orphan comment');
  });

  test('numbers comments starting from 1', () => {
    const file = makeFile('f1', 'src/a.ts');
    const payload: ReviewSubmitPayload = {
      type: 'submit',
      overallComment: 'overall',
      comments: [
        makeComment({
          id: 'c1',
          fileId: 'f1',
          startLine: 1,
          endLine: 1,
        }),
        makeComment({
          id: 'c2',
          fileId: 'f1',
          startLine: 2,
          endLine: 2,
          body: 'second',
        }),
      ],
    };
    const out = composeReviewPrompt(
      [
        file,
      ],
      payload,
    );
    expect(out).toMatch(/1\. \[branch diff\] src\/a\.ts:1/);
    expect(out).toMatch(/2\. \[branch diff\] src\/a\.ts:2/);
  });
});
