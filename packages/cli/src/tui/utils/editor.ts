/**
 * External editor detection.
 *
 * Ported from ~/Desktop/claude-code-main/src/utils/editor.ts. Looks at
 * VISUAL, then EDITOR env vars, falling back to platform defaults.
 */

import { spawnSync } from 'node:child_process';

//#region Detection

export interface EditorInfo {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly displayName: string;
}

function which(cmd: string): boolean {
  try {
    const result = spawnSync(
      process.platform === 'win32' ? 'where' : 'which',
      [
        cmd,
      ],
      {
        stdio: 'ignore',
      },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

function parseEditorEnv(value: string | undefined): EditorInfo | null {
  if (!value) {
    return null;
  }
  const parts = value.trim().split(/\s+/);
  const command = parts[0];
  if (!command) {
    return null;
  }
  return {
    command,
    args: parts.slice(1),
    displayName: command,
  };
}

export function detectEditor(): EditorInfo {
  const visual = parseEditorEnv(process.env.VISUAL);
  if (visual) {
    return visual;
  }
  const editor = parseEditorEnv(process.env.EDITOR);
  if (editor) {
    return editor;
  }
  const fallbacks =
    process.platform === 'win32'
      ? [
          'notepad',
        ]
      : [
          'nano',
          'vim',
          'vi',
        ];
  for (const candidate of fallbacks) {
    if (which(candidate)) {
      return {
        command: candidate,
        args: [],
        displayName: candidate,
      };
    }
  }
  return {
    command: 'vi',
    args: [],
    displayName: 'vi',
  };
}

//#endregion
