/**
 * Open the user's $EDITOR on a temp file preloaded with the given text, wait
 * for them to exit, and return the edited contents. Suspends stdin handling
 * so the editor has exclusive terminal control.
 *
 * Ported from ~/Desktop/claude-code-main/src/utils/promptEditor.ts — this
 * version uses `spawnSync` directly since Ink 7's `useApp` / `useStdin`
 * machinery is orchestrated by the caller (InputOptionEditor drops focus
 * around the call).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectEditor } from './editor.js';

//#region Public API

export class PromptEditorError extends Error {
  readonly kind = 'prompt-editor-failed' as const;
}

export function editInExternalEditor(initialText: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'noetic-ask-'));
  const file = join(dir, 'edit.md');
  try {
    writeFileSync(file, initialText, {
      encoding: 'utf-8',
    });
    const editor = detectEditor();
    const result = spawnSync(
      editor.command,
      [
        ...editor.args,
        file,
      ],
      {
        stdio: 'inherit',
      },
    );
    if (result.error) {
      throw new PromptEditorError(
        `failed to launch ${editor.displayName}: ${result.error.message}`,
      );
    }
    if (typeof result.status === 'number' && result.status !== 0) {
      throw new PromptEditorError(`${editor.displayName} exited with status ${result.status}`);
    }
    return readFileSync(file, 'utf-8');
  } finally {
    try {
      rmSync(dir, {
        recursive: true,
        force: true,
      });
    } catch {
      // Best-effort cleanup.
    }
  }
}

//#endregion
