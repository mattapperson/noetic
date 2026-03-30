import * as fs from 'node:fs/promises';

import type { SourceLocation } from '../types/source-location';

//#region Types

export interface WriteBackEntry {
  sourceLocation: SourceLocation;
  expectedValue?: string;
  newValue: string;
}

interface ReplaceArgs {
  content: string;
  location: SourceLocation;
  newValue: string;
  expectedValue?: string;
}

//#endregion

//#region Helper Functions

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

function replaceStringAtLocation(args: ReplaceArgs): string {
  const { content, location, newValue, expectedValue } = args;
  const lines = content.split('\n');
  const lineIdx = location.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) {
    return content;
  }

  const line = lines[lineIdx];
  const col = location.column;
  const quoteChar = line[col];
  if (quoteChar !== "'" && quoteChar !== '"' && quoteChar !== '`') {
    return content;
  }

  if (quoteChar === '`') {
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

    const escaped = newValue.replace(/\\/g, '\\\\').replace(/`/g, '\\`');

    const replacementLines = `${beforeQuote}${escaped}${afterQuote}`.split('\n');

    lines.splice(lineIdx, endLineIdx - lineIdx + 1, ...replacementLines);
    return lines.join('\n');
  }

  const end = findClosingQuoteSingleLine(line, quoteChar, col);
  const currentValue = line.slice(col + 1, end);

  if (expectedValue !== undefined && currentValue !== expectedValue) {
    throwSourceMismatch(location, expectedValue, currentValue);
  }

  const escaped = newValue
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(quoteChar, 'g'), `\\${quoteChar}`);
  const newLine = `${line.slice(0, col + 1)}${escaped}${line.slice(end)}`;
  lines[lineIdx] = newLine;
  return lines.join('\n');
}

async function writeToFile(filePath: string, entries: WriteBackEntry[]): Promise<void> {
  const content = await fs.readFile(filePath, 'utf-8');

  const sorted = [
    ...entries,
  ].sort((a, b) => b.sourceLocation.line - a.sourceLocation.line);

  let result = content;
  for (const entry of sorted) {
    result = replaceStringAtLocation({
      content: result,
      location: entry.sourceLocation,
      newValue: entry.newValue,
      expectedValue: entry.expectedValue,
    });
  }

  await fs.writeFile(filePath, result, 'utf-8');
}

//#endregion

//#region Public API

export async function writeOptimizedValues(entries: WriteBackEntry[]): Promise<void> {
  const byFile = groupByFile(entries);
  await Promise.all(
    [
      ...byFile.entries(),
    ].map(([filePath, fileEntries]) => writeToFile(filePath, fileEntries)),
  );
}

//#endregion
