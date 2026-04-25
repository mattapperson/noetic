/**
 * /diff-review — open a TUI review window for the current branch's git diff.
 *
 * Ported from `@ryan_nookpi/pi-extension-diff-review`. The pi extension
 * spawned a glimpseui native window and shipped feedback back as a paste; this
 * port renders the review UI directly in Ink and submits the composed
 * feedback as the next user turn via the JSX modal's prompt-result variant.
 */

import type { ReactNode } from 'react';

import type { Command, LocalJsxCommandCall } from '../../types.js';
import { getReviewWindowData } from './git.js';
import type { ReviewWindowData } from './types.js';
import { DiffReviewModal } from './ui/diff-review-modal.js';

//#region Implementation

const call: LocalJsxCommandCall = async (onDone, ctx, _args): Promise<ReactNode> => {
  let reviewData: ReviewWindowData;
  try {
    reviewData = await getReviewWindowData(ctx.cwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onDone(`Diff review failed: ${message}`);
    return null;
  }

  if (reviewData.files.length === 0 && reviewData.commits.length === 0) {
    onDone('No reviewable files found.');
    return null;
  }

  return (
    <DiffReviewModal
      reviewData={reviewData}
      onSubmit={(prompt: string) => {
        onDone({
          type: 'prompt',
          value: prompt,
        });
      }}
      onCancel={() => {
        onDone('Review cancelled.');
      }}
    />
  );
};

//#endregion

//#region Command Definition

export const diffReview: Command = {
  type: 'local-jsx',
  name: 'diff-review',
  description: 'Open a diff review window with branch, per-commit, and all-files scopes',
  load: async () => ({
    call,
  }),
};

//#endregion
