/**
 * Shared diff computation utilities for the edit tool.
 *
 * Ported from: https://github.com/OpenRouterTeam/sky
 */

import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import * as Diff from 'diff';
import { resolveToCwd } from './path-utils.js';

//#region Line Ending Helpers

export function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlfIdx = content.indexOf('\r\n');
  const lfIdx = content.indexOf('\n');
  if (lfIdx === -1) {
    return '\n';
  }
  if (crlfIdx === -1) {
    return '\n';
  }
  return crlfIdx < lfIdx ? '\r\n' : '\n';
}

export function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function restoreLineEndings(text: string, ending: '\r\n' | '\n'): string {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

export function stripBom(content: string): {
  bom: string;
  text: string;
} {
  return content.startsWith('\uFEFF')
    ? {
        bom: '\uFEFF',
        text: content.slice(1),
      }
    : {
        bom: '',
        text: content,
      };
}

//#endregion

//#region Diff Generation

export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): {
  diff: string;
  firstChangedLine: number | undefined;
} {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split('\n');
    if (raw[raw.length - 1] === '') {
      raw.pop();
    }

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum;
      }

      for (const line of raw) {
        if (part.added) {
          output.push(`+${String(newLineNum).padStart(lineNumWidth, ' ')} ${line}`);
          newLineNum++;
        } else {
          output.push(`-${String(oldLineNum).padStart(lineNumWidth, ' ')} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
      continue;
    }

    const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

    if (!lastWasChange && !nextPartIsChange) {
      oldLineNum += raw.length;
      newLineNum += raw.length;
      lastWasChange = false;
      continue;
    }

    let linesToShow = raw;
    let skipStart = 0;
    let skipEnd = 0;

    if (!lastWasChange) {
      skipStart = Math.max(0, raw.length - contextLines);
      linesToShow = raw.slice(skipStart);
    }

    if (!nextPartIsChange && linesToShow.length > contextLines) {
      skipEnd = linesToShow.length - contextLines;
      linesToShow = linesToShow.slice(0, contextLines);
    }

    if (skipStart > 0) {
      output.push(` ${''.padStart(lineNumWidth, ' ')} ...`);
      oldLineNum += skipStart;
      newLineNum += skipStart;
    }

    for (const line of linesToShow) {
      output.push(` ${String(oldLineNum).padStart(lineNumWidth, ' ')} ${line}`);
      oldLineNum++;
      newLineNum++;
    }

    if (skipEnd > 0) {
      output.push(` ${''.padStart(lineNumWidth, ' ')} ...`);
      oldLineNum += skipEnd;
      newLineNum += skipEnd;
    }

    lastWasChange = false;
  }

  return {
    diff: output.join('\n'),
    firstChangedLine,
  };
}

//#endregion

//#region Text Replacement

interface ReplacementSuccess {
  newContent: string;
}

interface ReplacementError {
  error: string;
}

interface ApplyReplacementParams {
  normalizedContent: string;
  normalizedOldText: string;
  normalizedNewText: string;
  path: string;
}

export function applyReplacement(
  params: ApplyReplacementParams,
): ReplacementSuccess | ReplacementError {
  const { normalizedContent, normalizedOldText, normalizedNewText, path } = params;
  if (!normalizedContent.includes(normalizedOldText)) {
    return {
      error: `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
    };
  }

  const occurrences = normalizedContent.split(normalizedOldText).length - 1;
  if (occurrences > 1) {
    return {
      error: `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
    };
  }

  const index = normalizedContent.indexOf(normalizedOldText);
  const newContent =
    normalizedContent.substring(0, index) +
    normalizedNewText +
    normalizedContent.substring(index + normalizedOldText.length);

  if (normalizedContent === newContent) {
    return {
      error: `No changes would be made to ${path}. The replacement produces identical content.`,
    };
  }

  return {
    newContent,
  };
}

//#endregion

//#region Edit Diff Computation

export interface EditDiffResult {
  diff: string;
  firstChangedLine: number | undefined;
}

export interface EditDiffError {
  error: string;
}

interface ComputeEditDiffParams {
  path: string;
  oldText: string;
  newText: string;
  cwd: string;
}

export async function computeEditDiff(
  params: ComputeEditDiffParams,
): Promise<EditDiffResult | EditDiffError> {
  const { path, oldText, newText, cwd } = params;
  const absolutePath = resolveToCwd(path, cwd);

  try {
    try {
      await access(absolutePath, constants.R_OK);
    } catch {
      return {
        error: `File not found: ${path}`,
      };
    }

    const rawContent = await readFile(absolutePath, 'utf-8');
    const { text: content } = stripBom(rawContent);

    const normalizedContent = normalizeToLf(content);
    const normalizedOldText = normalizeToLf(oldText);
    const normalizedNewText = normalizeToLf(newText);

    const replacement = applyReplacement({
      normalizedContent,
      normalizedOldText,
      normalizedNewText,
      path,
    });

    if ('error' in replacement) {
      return replacement;
    }

    return generateDiffString(normalizedContent, replacement.newContent);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

//#endregion
