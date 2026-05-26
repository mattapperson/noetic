/**
 * Compose review feedback into a follow-up prompt.
 *
 * Ported verbatim from upstream `@ryan_nookpi/pi-extension-diff-review`
 * (https://github.com/Jonghakseo/pi-extension/blob/main/packages/diff-review/prompt.ts).
 * Only the string-literal scope checks are swapped to use the as-const enum
 * values from `./types.ts` so the file follows the project's enum convention.
 */

import type { DiffReviewComment, ReviewFile, ReviewSubmitPayload } from './types.js';
import { CommentSide, ReviewCommitKind, ReviewScope } from './types.js';

//#region Helpers

function formatScopeLabel(comment: DiffReviewComment): string {
  if (comment.scope === ReviewScope.Branch) {
    return 'branch diff';
  }
  if (comment.scope === ReviewScope.Commits) {
    if (comment.commitKind === ReviewCommitKind.WorkingTree) {
      return 'working tree changes';
    }
    if (comment.commitShort) {
      return `commit ${comment.commitShort}`;
    }
    return 'commit';
  }
  return 'all files';
}

function getCommentFilePath(file: ReviewFile | undefined): string {
  if (file === undefined) {
    return '(unknown file)';
  }
  return file.gitDiff?.displayPath ?? file.path;
}

function formatLocation(comment: DiffReviewComment, file: ReviewFile | undefined): string {
  const filePath = getCommentFilePath(file);
  const scopePrefix = `[${formatScopeLabel(comment)}] `;

  if (comment.side === CommentSide.File || comment.startLine === null) {
    return `${scopePrefix}${filePath}`;
  }

  const range =
    comment.endLine !== null && comment.endLine !== comment.startLine
      ? `${comment.startLine}-${comment.endLine}`
      : `${comment.startLine}`;

  if (comment.scope === ReviewScope.All) {
    return `${scopePrefix}${filePath}:${range}`;
  }

  const suffix = comment.side === CommentSide.Original ? ' (old)' : ' (new)';
  return `${scopePrefix}${filePath}:${range}${suffix}`;
}

//#endregion

//#region Public API

export function composeReviewPrompt(
  files: ReadonlyArray<ReviewFile>,
  payload: ReviewSubmitPayload,
): string {
  const fileMap = new Map(
    files.map((file) => [
      file.id,
      file,
    ]),
  );
  const lines: string[] = [];

  lines.push('Please address the following feedback');
  lines.push('');

  const overallComment = payload.overallComment.trim();
  if (overallComment.length > 0) {
    lines.push(overallComment);
    lines.push('');
  }

  for (const [index, comment] of payload.comments.entries()) {
    const file = fileMap.get(comment.fileId);
    lines.push(`${index + 1}. ${formatLocation(comment, file)}`);
    lines.push(`   ${comment.body.trim()}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

//#endregion
