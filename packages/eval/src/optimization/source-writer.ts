import * as fs from 'node:fs/promises';

import type { SourceLocation } from '../types/source-location';

//#region Types

export interface WriteBackEntry {
  /** Position of the opening quote of the target string literal (1-based). */
  sourceLocation: SourceLocation;
  expectedValue?: string;
  newValue: string;
}

export interface SkippedWrite {
  sourceLocation: SourceLocation;
  reason: string;
}

/** Outcome of a write-back pass: replaced-literal count plus every skipped entry with its reason. */
export interface WriteBackReport {
  written: number;
  skipped: SkippedWrite[];
}

interface ReplaceArgs {
  content: string;
  location: SourceLocation;
  newValue: string;
  expectedValue?: string;
}

interface ReplaceResult {
  content: string;
  replaced: boolean;
  /** Populated when `replaced` is false. */
  reason?: string;
}

interface LineReplaceArgs {
  lines: string[];
  lineIdx: number;
  /** 0-based index of the opening quote within the line. */
  col: number;
  location: SourceLocation;
  newValue: string;
  expectedValue?: string;
}

//#endregion

//#region Helper Functions

// U+2028/U+2029 are line terminators in JS source; built from char codes so
// this file itself stays free of them.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

function groupByFile(entries: WriteBackEntry[]): Map<string, WriteBackEntry[]> {
  const byFile = new Map<string, WriteBackEntry[]>();
  for (const entry of entries) {
    const existing = byFile.get(entry.sourceLocation.filePath) ?? [];
    existing.push(entry);
    byFile.set(entry.sourceLocation.filePath, existing);
  }
  return byFile;
}

function findClosingQuoteSingleLine(line: string, quoteChar: string, startCol: number): number {
  let end = startCol + 1;
  while (end < line.length) {
    if (line[end] === '\\') {
      end += 2;
      continue;
    }
    if (line[end] === quoteChar) {
      break;
    }
    end++;
  }
  return end;
}

function findClosingBacktickMultiLine(
  lines: string[],
  lineIdx: number,
  startCol: number,
): {
  endLineIdx: number;
  endCol: number;
} {
  const joined = lines.slice(lineIdx).join('\n');
  const localStart = startCol + 1;

  let pos = localStart;
  while (pos < joined.length) {
    if (joined[pos] === '\\') {
      pos += 2;
      continue;
    }
    if (joined[pos] === '`') {
      break;
    }
    pos++;
  }

  let currentLine = lineIdx;
  let currentCol = startCol + 1;
  for (let i = localStart; i < pos; i++) {
    if (joined[i] === '\n') {
      currentLine++;
      currentCol = 0;
    } else {
      currentCol++;
    }
  }

  return {
    endLineIdx: currentLine,
    endCol: currentCol,
  };
}

function throwSourceMismatch(
  location: SourceLocation,
  expectedValue: string,
  currentValue: string,
): never {
  throw new Error(
    `Source mismatch at ${location.filePath}:${location.line}:${location.column}: ` +
      `expected ${JSON.stringify(expectedValue)} but found ${JSON.stringify(currentValue)}`,
  );
}

/**
 * Escape a replacement value for splicing into a template literal.
 * Backslash first, then backtick, then `${` (a live interpolation otherwise).
 */
function escapeForBacktick(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * Escape a replacement value for splicing into a single/double-quoted literal.
 * Backslash first, then the quote char, then line terminators (raw newlines
 * or U+2028/U+2029 would split the literal across lines — a syntax error).
 */
function escapeForQuote(value: string, quoteChar: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(quoteChar, 'g'), `\\${quoteChar}`)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replaceAll(LINE_SEPARATOR, '\\u2028')
    .replaceAll(PARAGRAPH_SEPARATOR, '\\u2029');
}

//#endregion

//#region Replacement

function replaceBacktickString(args: LineReplaceArgs): ReplaceResult {
  const { lines, lineIdx, col, location, newValue, expectedValue } = args;
  const { endLineIdx, endCol } = findClosingBacktickMultiLine(lines, lineIdx, col);

  const beforeQuote = lines[lineIdx].slice(0, col + 1);
  const afterQuote = lines[endLineIdx].slice(endCol);

  const currentParts: string[] = [];
  if (lineIdx === endLineIdx) {
    currentParts.push(lines[lineIdx].slice(col + 1, endCol));
  } else {
    currentParts.push(lines[lineIdx].slice(col + 1));
    for (let i = lineIdx + 1; i < endLineIdx; i++) {
      currentParts.push(lines[i]);
    }
    currentParts.push(lines[endLineIdx].slice(0, endCol));
  }
  const currentValue = currentParts.join('\n');

  if (expectedValue !== undefined && currentValue !== expectedValue) {
    throwSourceMismatch(location, expectedValue, currentValue);
  }

  const escaped = escapeForBacktick(newValue);
  const replacementLines = `${beforeQuote}${escaped}${afterQuote}`.split('\n');

  lines.splice(lineIdx, endLineIdx - lineIdx + 1, ...replacementLines);
  return {
    content: lines.join('\n'),
    replaced: true,
  };
}

function replaceQuotedString(
  args: LineReplaceArgs & {
    quoteChar: string;
  },
): ReplaceResult {
  const { lines, lineIdx, col, quoteChar, location, newValue, expectedValue } = args;
  const line = lines[lineIdx];
  const end = findClosingQuoteSingleLine(line, quoteChar, col);
  const currentValue = line.slice(col + 1, end);

  if (expectedValue !== undefined && currentValue !== expectedValue) {
    throwSourceMismatch(location, expectedValue, currentValue);
  }

  const escaped = escapeForQuote(newValue, quoteChar);
  lines[lineIdx] = `${line.slice(0, col + 1)}${escaped}${line.slice(end)}`;
  return {
    content: lines.join('\n'),
    replaced: true,
  };
}

/**
 * Replace the string literal whose opening quote sits at `location`
 * (1-based line and column). Never silently no-ops: a skipped replacement is
 * reported via `{ replaced: false, reason }`.
 */
function replaceStringAtLocation(args: ReplaceArgs): ReplaceResult {
  const { content, location, newValue, expectedValue } = args;
  const lines = content.split('\n');
  const lineIdx = location.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) {
    return {
      content,
      replaced: false,
      reason: `line ${location.line} is out of range (file has ${lines.length} lines)`,
    };
  }

  const line = lines[lineIdx];
  // SourceLocation.column is 1-based; string indexing is 0-based.
  const col = location.column - 1;
  const quoteChar = col >= 0 ? line[col] : undefined;
  if (quoteChar !== "'" && quoteChar !== '"' && quoteChar !== '`') {
    return {
      content,
      replaced: false,
      reason: `no string literal opens at column ${location.column} (found ${JSON.stringify(quoteChar ?? 'nothing')})`,
    };
  }

  if (quoteChar === '`') {
    return replaceBacktickString({
      lines,
      lineIdx,
      col,
      location,
      newValue,
      expectedValue,
    });
  }
  return replaceQuotedString({
    lines,
    lineIdx,
    col,
    quoteChar,
    location,
    newValue,
    expectedValue,
  });
}

//#endregion

//#region Public API

async function writeToFile(filePath: string, entries: WriteBackEntry[]): Promise<WriteBackReport> {
  const content = await fs.readFile(filePath, 'utf-8');

  // Bottom-up, right-to-left: later replacements must not shift the
  // line/column coordinates of earlier ones (incl. two entries on one line).
  const sorted = [
    ...entries,
  ].sort(
    (a, b) =>
      b.sourceLocation.line - a.sourceLocation.line ||
      b.sourceLocation.column - a.sourceLocation.column,
  );

  const report: WriteBackReport = {
    written: 0,
    skipped: [],
  };

  let result = content;
  for (const entry of sorted) {
    const replacement = replaceStringAtLocation({
      content: result,
      location: entry.sourceLocation,
      newValue: entry.newValue,
      expectedValue: entry.expectedValue,
    });
    result = replacement.content;
    if (replacement.replaced) {
      report.written++;
      continue;
    }
    report.skipped.push({
      sourceLocation: entry.sourceLocation,
      reason: replacement.reason ?? 'unknown',
    });
  }

  if (report.written > 0) {
    await fs.writeFile(filePath, result, 'utf-8');
  }
  return report;
}

/**
 * Write optimized values back into source files. Returns a report of how
 * many literals were replaced and which entries were skipped (stale or
 * non-literal locations). A file is left untouched when every entry for it
 * was skipped.
 */
export async function writeOptimizedValues(entries: WriteBackEntry[]): Promise<WriteBackReport> {
  const byFile = groupByFile(entries);
  const reports = await Promise.all(
    [
      ...byFile.entries(),
    ].map(([filePath, fileEntries]) => writeToFile(filePath, fileEntries)),
  );

  const combined: WriteBackReport = {
    written: 0,
    skipped: [],
  };
  for (const r of reports) {
    combined.written += r.written;
    combined.skipped.push(...r.skipped);
  }
  return combined;
}

//#endregion
