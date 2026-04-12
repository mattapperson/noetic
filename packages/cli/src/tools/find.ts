/**
 * Find tool — search for files by glob pattern.
 *
 * Ported from: https://github.com/OpenRouterTeam/sky
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '@noetic/core';
import { tool } from '@noetic/core';
import { globSync } from 'glob';
import { z } from 'zod';
import { pathExists, resolveToCwd } from './path-utils.js';
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from './truncate.js';

//#region Constants

const DEFAULT_LIMIT = 1e3;

//#endregion

//#region Types

export interface FindOperations {
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  glob: (
    pattern: string,
    cwd: string,
    options: {
      ignore: string[];
      limit: number;
    },
  ) => Promise<string[]> | string[];
}

//#endregion

//#region Schemas

const FindInputSchema = z.object({
  pattern: z
    .string()
    .describe("Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'"),
  path: z.string().optional().describe('Directory to search in (default: current directory)'),
  limit: z.number().optional().describe(`Maximum number of results (default: ${DEFAULT_LIMIT})`),
});

export const FindOutputSchema = z.object({
  files: z.string().describe('List of matching files (newline separated)'),
  pattern: z.string().describe('The pattern that was searched'),
  fileCount: z.number().describe('Number of files found'),
  truncated: z.boolean().describe('Whether results were truncated'),
  limitReached: z.boolean().describe('Whether result limit was reached'),
});

export type FindOutput = z.infer<typeof FindOutputSchema>;

//#endregion

//#region Default Operations

async function loadGitignorePatterns(searchCwd: string): Promise<string[]> {
  const patterns: string[] = [];
  try {
    const content = await readFile(path.join(searchCwd, '.gitignore'), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) {
        continue;
      }
      patterns.push(trimmed);
    }
  } catch {
    // No .gitignore or can't read
  }
  return patterns;
}

const defaultFindOperations: FindOperations = {
  exists: pathExists,
  glob: async (pattern, searchCwd, options) => {
    const gitignorePatterns = await loadGitignorePatterns(searchCwd);
    const ignorePatterns = [
      ...options.ignore,
      ...gitignorePatterns,
    ];

    const results = globSync(pattern, {
      cwd: searchCwd,
      dot: true,
      ignore: ignorePatterns,
      nodir: true,
    });

    return results.slice(0, options.limit);
  },
};

//#endregion

//#region Tool Description

const FIND_TOOL_DESCRIPTION = `Search for files by glob pattern.

Usage notes:
- Use glob patterns like "**/*.ts" or "src/**/*.tsx"
- Respects .gitignore by default
- Returns paths relative to search directory, sorted by modification time
- Output truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB

Parameters:
- pattern: Glob pattern to match files (e.g., "**/*.ts", "src/**/*.tsx")
- path: Directory to search in (default: current directory)
- limit: Maximum results (default: ${DEFAULT_LIMIT})

When to use:
- Finding files by name or extension pattern
- Locating configuration files
- Discovering project structure

When NOT to use:
- Searching file contents: Use grep tool
- Listing single directory: Use ls tool
- Reading file contents: Use read tool`;

//#endregion

//#region Public API

export interface FindToolOptions {
  operations?: FindOperations;
}

export type FindTool = Tool<typeof FindInputSchema, typeof FindOutputSchema>;

export function createFindTool(cwd: string, options?: FindToolOptions): FindTool {
  const customOps = options?.operations ?? defaultFindOperations;

  return tool({
    name: 'Find',
    description: FIND_TOOL_DESCRIPTION,
    input: FindInputSchema,
    output: FindOutputSchema,
    async execute(params) {
      const { pattern, path: searchDir, limit } = params;
      const searchPath = resolveToCwd(searchDir || '.', cwd);
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      try {
        if (!(await customOps.exists(searchPath))) {
          throw new Error(`Path not found: ${searchPath}`);
        }

        const results = await customOps.glob(pattern, searchPath, {
          ignore: [
            '**/node_modules/**',
            '**/.git/**',
          ],
          limit: effectiveLimit,
        });

        if (results.length === 0) {
          return {
            files: 'No files found matching pattern',
            pattern,
            fileCount: 0,
            truncated: false,
            limitReached: false,
          };
        }

        const relativized = results.map((p) => {
          if (path.isAbsolute(p)) {
            return p.startsWith(searchPath)
              ? p.slice(searchPath.length + 1)
              : path.relative(searchPath, p);
          }
          return p;
        });

        const resultLimitReached = relativized.length >= effectiveLimit;
        const rawOutput = relativized.join('\n');
        const truncation = truncateHead(rawOutput, {
          maxLines: Number.MAX_SAFE_INTEGER,
        });

        let output = truncation.content;
        const notices: string[] = [];

        if (resultLimitReached) {
          notices.push(
            `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
          );
        }

        if (truncation.truncated) {
          notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        }

        if (notices.length > 0) {
          output += `\n\n[${notices.join('. ')}]`;
        }

        return {
          files: output,
          pattern,
          fileCount: relativized.length,
          truncated: truncation.truncated,
          limitReached: resultLimitReached,
        };
      } catch (e) {
        return {
          files: e instanceof Error ? e.message : String(e),
          pattern,
          fileCount: 0,
          truncated: false,
          limitReached: false,
        };
      }
    },
  });
}

//#endregion
