/**
 * Grep tool — search file contents using ripgrep.
 *
 * Ported from: https://github.com/OpenRouterTeam/sky
 */

import path from 'node:path';
import type { FsAdapter, ShellAdapter, Tool } from '@noetic/core';
import { tool } from '@noetic/core';
import { z } from 'zod';
import { normalizeToLf } from './edit-diff.js';
import { resolveToCwd } from './path-utils.js';
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  truncateHead,
  truncateLine,
} from './truncate.js';

//#region Constants

const DEFAULT_LIMIT = 1e2;

//#endregion

//#region Schemas

const GrepInputSchema = z.object({
  pattern: z.string().describe('Search pattern (regex or literal string)'),
  path: z.string().optional().describe('Directory or file to search (default: current directory)'),
  glob: z
    .string()
    .optional()
    .describe("Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'"),
  ignoreCase: z.boolean().optional().describe('Case-insensitive search (default: false)'),
  literal: z
    .boolean()
    .optional()
    .describe('Treat pattern as literal string instead of regex (default: false)'),
  context: z
    .number()
    .optional()
    .describe('Number of lines to show before and after each match (default: 0)'),
  limit: z
    .number()
    .optional()
    .describe(`Maximum number of matches to return (default: ${DEFAULT_LIMIT})`),
});

export const GrepOutputSchema = z.object({
  matches: z.string().describe('Search results with file paths and line numbers'),
  pattern: z.string().describe('The pattern that was searched'),
  matchCount: z.number().describe('Number of matches found'),
  truncated: z.boolean().describe('Whether results were truncated'),
  limitReached: z.boolean().describe('Whether match limit was reached'),
});

export type GrepOutput = z.infer<typeof GrepOutputSchema>;

//#endregion

//#region Tool Description

const GREP_TOOL_DESCRIPTION = `Search file contents for patterns using ripgrep.

IMPORTANT: ALWAYS use this tool for search tasks. NEVER use grep or rg as bash commands.

Usage notes:
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Respects .gitignore by default
- Use glob to filter by file pattern (e.g., "*.ts", "**/*.tsx")
- Output truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB. Long lines truncated to ${GREP_MAX_LINE_LENGTH} chars.

Parameters:
- pattern: Regex pattern (or literal string if literal=true)
- path: Directory or file to search (default: current directory)
- glob: Filter files by glob pattern
- ignoreCase: Case-insensitive search
- literal: Treat pattern as literal string (disables regex)
- context: Lines to show before/after matches
- limit: Maximum matches (default: ${DEFAULT_LIMIT})

When to use:
- Finding code patterns across files
- Locating function definitions or usages
- Searching for error messages or strings

When NOT to use:
- Finding files by name: Use find tool
- Reading specific file contents: Use read tool`;

//#endregion

//#region Helpers

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

interface ParsedMatch {
  filePath: string;
  lineNumber: number;
}

function parseRgOutput(
  stdout: string,
  effectiveLimit: number,
): {
  matches: ParsedMatch[];
  matchLimitReached: boolean;
} {
  const stdoutLines = stdout.split('\n');
  const matches: ParsedMatch[] = [];
  let matchLimitReached = false;

  for (const line of stdoutLines) {
    if (matches.length >= effectiveLimit) {
      matchLimitReached = true;
      break;
    }
    if (!line.trim()) {
      continue;
    }

    const firstColon = line.indexOf(':');
    if (firstColon === -1) {
      continue;
    }
    const secondColon = line.indexOf(':', firstColon + 1);
    if (secondColon === -1) {
      continue;
    }

    const filePath = line.slice(0, firstColon);
    const lineNumber = Number.parseInt(line.slice(firstColon + 1, secondColon), 10);

    if (Number.isNaN(lineNumber)) {
      continue;
    }

    matches.push({
      filePath,
      lineNumber,
    });
  }

  return {
    matches,
    matchLimitReached,
  };
}

interface FormatMatchesParams {
  matches: ParsedMatch[];
  searchPath: string;
  isDirectory: boolean;
  contextValue: number;
  fs: FsAdapter;
}

async function formatMatches(params: FormatMatchesParams): Promise<{
  outputLines: string[];
  linesTruncated: boolean;
}> {
  const { matches, searchPath, isDirectory, contextValue, fs } = params;
  const fileCache = new Map<string, string[]>();
  const outputLines: string[] = [];
  let linesTruncated = false;

  async function getFileLines(filePath: string): Promise<string[]> {
    let lines = fileCache.get(filePath);
    if (!lines) {
      try {
        const content = await fs.readFileText(filePath);
        lines = normalizeToLf(content).split('\n');
      } catch {
        lines = [];
      }
      fileCache.set(filePath, lines);
    }
    return lines;
  }

  function formatFilePath(filePath: string): string {
    if (!isDirectory) {
      return path.basename(filePath);
    }
    const relative = path.relative(searchPath, filePath);
    if (relative && !relative.startsWith('..')) {
      return relative.replace(/\\/g, '/');
    }
    return path.basename(filePath);
  }

  for (const match of matches) {
    const absFilePath = path.isAbsolute(match.filePath)
      ? match.filePath
      : path.resolve(searchPath, match.filePath);
    const relativePath = formatFilePath(absFilePath);
    const lines = await getFileLines(absFilePath);

    if (!lines.length) {
      outputLines.push(`${relativePath}:${match.lineNumber}: (unable to read file)`);
      continue;
    }

    const start =
      contextValue > 0 ? Math.max(1, match.lineNumber - contextValue) : match.lineNumber;
    const end =
      contextValue > 0 ? Math.min(lines.length, match.lineNumber + contextValue) : match.lineNumber;

    for (let current = start; current <= end; current++) {
      const lineText = lines[current - 1] ?? '';
      const { text: truncatedText, wasTruncated } = truncateLine(lineText);
      if (wasTruncated) {
        linesTruncated = true;
      }

      if (current === match.lineNumber) {
        outputLines.push(`${relativePath}:${current}: ${truncatedText}`);
      } else {
        outputLines.push(`${relativePath}-${current}- ${truncatedText}`);
      }
    }
  }

  return {
    outputLines,
    linesTruncated,
  };
}

//#endregion

//#region Public API

export type GrepTool = Tool<typeof GrepInputSchema, typeof GrepOutputSchema>;

export function createGrepTool(cwd: string, fs: FsAdapter, shell: ShellAdapter): GrepTool {
  return tool({
    name: 'Grep',
    description: GREP_TOOL_DESCRIPTION,
    input: GrepInputSchema,
    output: GrepOutputSchema,
    async execute(params) {
      const {
        pattern,
        path: searchDir,
        glob: globPattern,
        ignoreCase,
        literal,
        context,
        limit,
      } = params;
      const searchPath = resolveToCwd(searchDir || '.', cwd);
      const contextValue = context && context > 0 ? context : 0;
      const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

      try {
        const searchStat = await fs.stat(searchPath).catch(() => null);
        if (!searchStat) {
          throw new Error(`Path not found: ${searchPath}`);
        }
        const isDirectory = searchStat.isDirectory();

        const cmdParts: string[] = [
          'rg',
          '--line-number',
          '--hidden',
          '-H',
        ];
        if (ignoreCase) {
          cmdParts.push('--ignore-case');
        }
        if (literal) {
          cmdParts.push('--fixed-strings');
        }
        if (globPattern) {
          cmdParts.push('--glob', shellQuote(globPattern));
        }
        cmdParts.push(shellQuote(pattern), shellQuote(searchPath));

        const result = await shell.exec(cmdParts.join(' '), {
          cwd: searchPath,
        });

        const { stdout, stderr, exitCode } = result;

        const { matches, matchLimitReached } = parseRgOutput(stdout, effectiveLimit);

        if (matches.length === 0 && (exitCode === null || exitCode <= 1)) {
          return {
            matches: 'No matches found',
            pattern,
            matchCount: 0,
            truncated: false,
            limitReached: false,
          };
        }

        if (matches.length === 0 && exitCode !== null && exitCode > 1) {
          throw new Error(stderr.trim() || `rg exited with code ${exitCode}`);
        }

        const { outputLines, linesTruncated } = await formatMatches({
          matches,
          searchPath,
          isDirectory,
          contextValue,
          fs,
        });

        const rawOutput = outputLines.join('\n');
        const truncation = truncateHead(rawOutput, {
          maxLines: Number.MAX_SAFE_INTEGER,
        });

        let output = truncation.content;
        const notices: string[] = [];

        if (matchLimitReached) {
          notices.push(
            `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
          );
        }

        if (truncation.truncated) {
          notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        }

        if (linesTruncated) {
          notices.push(
            `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
          );
        }

        if (notices.length > 0) {
          output += `\n\n[${notices.join('. ')}]`;
        }

        return {
          matches: output,
          pattern,
          matchCount: matches.length,
          truncated: truncation.truncated,
          limitReached: matchLimitReached,
        };
      } catch (e) {
        return {
          matches: e instanceof Error ? e.message : String(e),
          pattern,
          matchCount: 0,
          truncated: false,
          limitReached: false,
        };
      }
    },
  });
}

//#endregion
