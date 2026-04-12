/**
 * Ls tool — list files and directories.
 *
 * Ported from: https://github.com/OpenRouterTeam/sky
 */

import { readdir, stat } from 'node:fs/promises';
import nodePath from 'node:path';
import type { Tool } from '@noetic/core';
import { tool } from '@noetic/core';
import { z } from 'zod';
import { pathExists, resolveToCwd } from './path-utils.js';
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from './truncate.js';

//#region Constants

const DEFAULT_LIMIT = 5e2;

//#endregion

//#region Types

export interface LsOperations {
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  stat: (absolutePath: string) =>
    | Promise<{
        isDirectory: () => boolean;
      }>
    | {
        isDirectory: () => boolean;
      };
  readdir: (absolutePath: string) => Promise<string[]> | string[];
}

//#endregion

//#region Schemas

const LsInputSchema = z.object({
  path: z.string().optional().describe('Directory to list (default: current directory)'),
  limit: z
    .number()
    .optional()
    .describe(`Maximum number of entries to return (default: ${DEFAULT_LIMIT})`),
});

export const LsOutputSchema = z.object({
  entries: z.string().describe('List of entries (newline separated, directories end with /)'),
  path: z.string().describe('The directory that was listed'),
  entryCount: z.number().describe('Number of entries listed'),
  truncated: z.boolean().describe('Whether results were truncated'),
  limitReached: z.boolean().describe('Whether entry limit was reached'),
});

export type LsOutput = z.infer<typeof LsOutputSchema>;

//#endregion

//#region Default Operations

const defaultLsOperations: LsOperations = {
  exists: pathExists,
  stat: async (absolutePath) => {
    const s = await stat(absolutePath);
    return {
      isDirectory: () => s.isDirectory(),
    };
  },
  readdir: (absolutePath) => readdir(absolutePath),
};

//#endregion

//#region Tool Description

const LS_TOOL_DESCRIPTION = `List files and directories in a given path.

Usage notes:
- Returns entries sorted alphabetically with '/' suffix for directories
- Includes dotfiles
- Default path is current working directory
- Output truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB

Parameters:
- path: Directory path (default: current directory)
- limit: Maximum entries (default: ${DEFAULT_LIMIT})

When to use:
- Understanding directory structure
- Finding files to read or edit
- Exploring unfamiliar codebases

When NOT to use:
- Finding files by pattern: Use find tool with glob
- Searching file contents: Use grep tool
- Recursive file listing: Use find tool`;

//#endregion

//#region Helpers

interface FormatEntriesParams {
  dirPath: string;
  entries: string[];
  effectiveLimit: number;
  ops: LsOperations;
}

async function formatEntries(params: FormatEntriesParams): Promise<{
  results: string[];
  entryLimitReached: boolean;
}> {
  const { dirPath, entries, effectiveLimit, ops } = params;
  const results: string[] = [];
  let entryLimitReached = false;

  for (const entry of entries) {
    if (results.length >= effectiveLimit) {
      entryLimitReached = true;
      break;
    }

    const fullPath = nodePath.join(dirPath, entry);
    let suffix = '';

    try {
      const entryStat = await ops.stat(fullPath);
      if (entryStat.isDirectory()) {
        suffix = '/';
      }
    } catch {
      continue;
    }

    results.push(entry + suffix);
  }

  return {
    results,
    entryLimitReached,
  };
}

//#endregion

//#region Public API

export interface LsToolOptions {
  operations?: LsOperations;
}

export type LsTool = Tool<typeof LsInputSchema, typeof LsOutputSchema>;

export function createLsTool(cwd: string, options?: LsToolOptions): LsTool {
  const ops = options?.operations ?? defaultLsOperations;

  return tool({
    name: 'Ls',
    description: LS_TOOL_DESCRIPTION,
    input: LsInputSchema,
    output: LsOutputSchema,
    async execute(params) {
      const { path, limit } = params;
      const dirPath = resolveToCwd(path || '.', cwd);
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      try {
        if (!(await ops.exists(dirPath))) {
          throw new Error(`Path not found: ${dirPath}`);
        }

        const dirStat = await ops.stat(dirPath);
        if (!dirStat.isDirectory()) {
          throw new Error(`Not a directory: ${dirPath}`);
        }

        const rawEntries = await ops.readdir(dirPath);
        rawEntries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

        const { results, entryLimitReached } = await formatEntries({
          dirPath,
          entries: rawEntries,
          effectiveLimit,
          ops,
        });

        if (results.length === 0) {
          return {
            entries: '(empty directory)',
            path: dirPath,
            entryCount: 0,
            truncated: false,
            limitReached: false,
          };
        }

        const rawOutput = results.join('\n');
        const truncation = truncateHead(rawOutput, {
          maxLines: Number.MAX_SAFE_INTEGER,
        });

        let output = truncation.content;
        const notices: string[] = [];

        if (entryLimitReached) {
          notices.push(
            `${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`,
          );
        }

        if (truncation.truncated) {
          notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        }

        if (notices.length > 0) {
          output += `\n\n[${notices.join('. ')}]`;
        }

        return {
          entries: output,
          path: dirPath,
          entryCount: results.length,
          truncated: truncation.truncated,
          limitReached: entryLimitReached,
        };
      } catch (e) {
        return {
          entries: e instanceof Error ? e.message : String(e),
          path: dirPath,
          entryCount: 0,
          truncated: false,
          limitReached: false,
        };
      }
    },
  });
}

//#endregion
