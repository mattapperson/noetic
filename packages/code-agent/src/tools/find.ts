/**
 * Find tool — search for files by glob pattern.
 *
 * Ported from: https://github.com/OpenRouterTeam/sky
 */

import path from 'node:path';
import type { FsAdapter, Tool } from '@noetic-tools/core';
import { getToolCwd, tool } from '@noetic-tools/core';
import { globSync } from 'glob';
import { z } from 'zod';
import { resolveToCwd } from './path-utils.js';
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from './truncate.js';

//#region Constants

const DEFAULT_LIMIT = 1e3;

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

//#region Helpers

async function loadGitignorePatterns(searchCwd: string, fs: FsAdapter): Promise<string[]> {
  const patterns: string[] = [];
  try {
    const content = await fs.readFileText(path.join(searchCwd, '.gitignore'));
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

//#endregion

//#region Public API

export type FindTool = Tool<typeof FindInputSchema, typeof FindOutputSchema>;

export function createFindTool(cwd: string, fs: FsAdapter): FindTool {
  return tool({
    name: 'Find',
    description: FIND_TOOL_DESCRIPTION,
    input: FindInputSchema,
    output: FindOutputSchema,
    async execute(params, toolCtx) {
      const { pattern, path: searchDir, limit } = params;
      const liveCwd = getToolCwd(toolCtx.ctx, cwd);
      const searchPath = resolveToCwd(searchDir || '.', liveCwd);
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      try {
        const searchStat = await fs.stat(searchPath).catch(() => null);
        if (!searchStat) {
          throw new Error(`Path not found: ${searchPath}`);
        }

        const gitignorePatterns = await loadGitignorePatterns(searchPath, fs);
        const ignorePatterns = [
          '**/node_modules/**',
          '**/.git/**',
          ...gitignorePatterns,
        ];

        const results = globSync(pattern, {
          cwd: searchPath,
          dot: true,
          ignore: ignorePatterns,
          nodir: true,
        }).slice(0, effectiveLimit);

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
