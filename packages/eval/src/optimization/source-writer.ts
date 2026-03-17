import * as fs from 'node:fs';

import type { SourceLocation } from '../types/source-location';

//#region Types

export interface WriteBackEntry {
  sourceLocation: SourceLocation;
  newValue: string;
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

function replaceStringAtLocation(
  content: string,
  location: SourceLocation,
  newValue: string,
): string {
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

  let end = col + 1;
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

  const escaped = newValue
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(quoteChar, 'g'), `\\${quoteChar}`);
  const newLine = `${line.slice(0, col + 1)}${escaped}${line.slice(end)}`;
  lines[lineIdx] = newLine;
  return lines.join('\n');
}

async function writeToFile(filePath: string, entries: WriteBackEntry[]): Promise<void> {
  const content = fs.readFileSync(filePath, 'utf-8');

  const sorted = [
    ...entries,
  ].sort((a, b) => b.sourceLocation.line - a.sourceLocation.line);

  let result = content;
  for (const entry of sorted) {
    result = replaceStringAtLocation(result, entry.sourceLocation, entry.newValue);
  }

  fs.writeFileSync(filePath, result, 'utf-8');
}

//#endregion

//#region Public API

export async function writeOptimizedValues(entries: WriteBackEntry[]): Promise<void> {
  const byFile = groupByFile(entries);
  for (const [filePath, fileEntries] of byFile) {
    await writeToFile(filePath, fileEntries);
  }
}

//#endregion
