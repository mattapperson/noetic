/**
 * Tool-specific preview of a tool call's raw JSON `arguments` string, used to
 * populate the `(…)` suffix on a ToolCall header.
 *
 * - Generic path: pick the first preferred key (path/file/command/…) and show
 *   its value truncated.
 * - Per-tool path: a handler registry can format a nicer one-line summary for
 *   tools whose input shape doesn't match the preferred-key heuristic — e.g.
 *   `lsp` whose most useful args are `operation` + `filePath:line:character`.
 */

import { relativizeHome } from './paths.js';

//#region Constants

const MAX_ARGS_PREVIEW = 8e1;

const PREFERRED_ARG_KEYS = [
  'path',
  'file',
  'file_path',
  'filePath',
  'command',
  'pattern',
  'query',
] as const;

//#endregion

//#region Types

type ParsedArgs = Record<string, unknown>;

type ToolArgsPreview = (parsed: ParsedArgs) => string | null;

//#endregion

//#region Helpers

function isRecord(value: unknown): value is ParsedArgs {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}

function genericPreview(parsed: ParsedArgs): string {
  for (const key of PREFERRED_ARG_KEYS) {
    const value = parsed[key];
    if (typeof value === 'string') {
      return truncate(value, MAX_ARGS_PREVIEW);
    }
  }
  return '';
}

//#endregion

//#region Per-tool Previewers

function lspPreview(parsed: ParsedArgs): string | null {
  const operation = typeof parsed.operation === 'string' ? parsed.operation : null;
  const filePath = typeof parsed.filePath === 'string' ? parsed.filePath : null;
  const line = typeof parsed.line === 'number' ? parsed.line : null;
  const character = typeof parsed.character === 'number' ? parsed.character : null;

  if (!filePath && !operation) {
    return null;
  }
  if (!filePath) {
    return operation;
  }
  const relative = relativizeHome(filePath);
  const position = line !== null && character !== null ? `:${line}:${character}` : '';
  const rendered = operation ? `${operation} ${relative}${position}` : `${relative}${position}`;
  return truncate(rendered, MAX_ARGS_PREVIEW);
}

const TOOL_ARG_PREVIEWS: Record<string, ToolArgsPreview> = {
  lsp: lspPreview,
};

//#endregion

//#region Public API

export function previewToolArgs(toolName: string, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return '';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return truncate(trimmed, MAX_ARGS_PREVIEW);
  }
  if (!isRecord(parsed)) {
    return truncate(trimmed, MAX_ARGS_PREVIEW);
  }
  const custom = TOOL_ARG_PREVIEWS[toolName];
  if (custom) {
    const rendered = custom(parsed);
    if (rendered !== null) {
      return rendered;
    }
  }
  return genericPreview(parsed);
}

//#endregion
