/**
 * Groups consecutive Read/Ls/Find/Grep tool calls (and their matching
 * function_call_output entries) into a single CollapsedReadGroup summary.
 *
 * Boundaries break on assistant text, user input, system/error entries, or
 * any tool call whose name is not in the collapsible set.
 */

import { z } from 'zod';
import type { ConversationEntry } from '../item-utils.js';
import { isErrorEntry, isSystemEntry, isUserEntry } from '../item-utils.js';
import type { CollapsedReadGroup, DisplayEntry } from './types.js';
import { CollapsibleToolName } from './types.js';

//#region Lookup

const TOOL_BY_NAME: ReadonlyMap<string, CollapsibleToolName> = new Map(
  Object.values(CollapsibleToolName).map((tool) => [
    tool,
    tool,
  ]),
);

//#endregion

//#region Schemas

const ToolArgsSchema = z
  .object({
    path: z.string().optional(),
    pattern: z.string().optional(),
  })
  .passthrough();

type ToolArgs = z.infer<typeof ToolArgsSchema>;

//#endregion

//#region Types

interface Accumulator {
  firstId: string;
  callIds: Set<string>;
  readPaths: string[];
  listPaths: string[];
  searchPatterns: string[];
  seenReads: Set<string>;
  seenLists: Set<string>;
  seenSearches: Set<string>;
  latestHint: string;
}

//#endregion

//#region Helpers

function classify(name: string): CollapsibleToolName | null {
  return TOOL_BY_NAME.get(name) ?? null;
}

function parseArgs(raw: string | undefined): ToolArgs {
  if (!raw) {
    return {};
  }
  try {
    const parsed = ToolArgsSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return {};
    }
    return parsed.data;
  } catch {
    return {};
  }
}

function trackUnique(bucket: string[], seen: Set<string>, value: string): void {
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  bucket.push(value);
}

function newAccumulator(firstId: string): Accumulator {
  return {
    firstId,
    callIds: new Set(),
    readPaths: [],
    listPaths: [],
    searchPatterns: [],
    seenReads: new Set(),
    seenLists: new Set(),
    seenSearches: new Set(),
    latestHint: '',
  };
}

type CallHandler = (acc: Accumulator, args: ToolArgs) => void;

const handleSearch: CallHandler = (acc, { pattern }) => {
  if (!pattern) {
    return;
  }
  trackUnique(acc.searchPatterns, acc.seenSearches, pattern);
  acc.latestHint = pattern;
};

const CALL_HANDLERS: Record<CollapsibleToolName, CallHandler> = {
  Read: (acc, { path }) => {
    if (!path) {
      return;
    }
    trackUnique(acc.readPaths, acc.seenReads, path);
    acc.latestHint = path;
  },
  Ls: (acc, { path }) => {
    const target = path ?? '.';
    trackUnique(acc.listPaths, acc.seenLists, target);
    acc.latestHint = target;
  },
  Find: handleSearch,
  Grep: handleSearch,
};

function addCall(acc: Accumulator, tool: CollapsibleToolName, args: ToolArgs): void {
  CALL_HANDLERS[tool](acc, args);
}

function toGroup(acc: Accumulator): CollapsedReadGroup {
  return {
    kind: 'collapsed-read-group',
    id: `group-${acc.firstId}`,
    readPaths: acc.readPaths,
    listPaths: acc.listPaths,
    searchPatterns: acc.searchPatterns,
    latestHint: acc.latestHint,
  };
}

//#endregion

//#region Public API

/**
 * Walk `entries` once and emit a `DisplayEntry[]` with consecutive collapsible
 * tool calls (and their matching outputs) replaced by a single
 * `CollapsedReadGroup`. Non-collapsible entries pass through unchanged.
 */
export function collapseReads(entries: ReadonlyArray<ConversationEntry>): DisplayEntry[] {
  const out: DisplayEntry[] = [];
  let acc: Accumulator | null = null;

  const flush = (): void => {
    if (acc) {
      out.push(toGroup(acc));
      acc = null;
    }
  };

  for (const entry of entries) {
    if (isUserEntry(entry) || isErrorEntry(entry) || isSystemEntry(entry)) {
      flush();
      out.push(entry);
      continue;
    }
    if (entry.type === 'function_call') {
      const tool = classify(entry.name);
      if (!tool) {
        flush();
        out.push(entry);
        continue;
      }
      acc ??= newAccumulator(entry.callId);
      acc.callIds.add(entry.callId);
      addCall(acc, tool, parseArgs(entry.arguments));
      continue;
    }
    if (entry.type === 'function_call_output') {
      if (acc?.callIds.has(entry.callId)) {
        continue;
      }
      flush();
      out.push(entry);
      continue;
    }
    flush();
    out.push(entry);
  }

  flush();
  return out;
}

//#endregion
