/**
 * Write tool — write content to a file.
 *
 * Ported from: https://github.com/OpenRouterTeam/sky
 */

import { dirname } from 'node:path';
import type { FsAdapter, Tool } from '@noetic/core';
import { tool } from '@noetic/core';
import { z } from 'zod';
import { resolveToCwd } from './path-utils.js';

//#region Schemas

const WriteInputSchema = z.object({
  path: z.string().describe('Path to the file to write (relative or absolute)'),
  content: z.string().describe('Content to write to the file'),
});

export const WriteOutputSchema = z.object({
  path: z.string().describe('The file path that was written'),
  bytesWritten: z.number().describe('Number of bytes written'),
  success: z.boolean().describe('Whether the write succeeded'),
  message: z.string().describe('Status message'),
});

export type WriteOutput = z.infer<typeof WriteOutputSchema>;

//#endregion

//#region Tool Description

const WRITE_TOOL_DESCRIPTION = `Write content to a file, creating it if it doesn't exist.

IMPORTANT: If the file already exists, you MUST read it first with the read tool to prevent accidental overwrites.

Usage notes:
- Creates parent directories automatically if needed
- Overwrites existing files completely
- ALWAYS prefer editing existing files over creating new ones
- NEVER create documentation files unless explicitly requested

Parameters:
- path: File path to write (relative or absolute)
- content: The complete file content

When to use:
- Creating new files that don't exist
- Completely rewriting a file's content

When NOT to use:
- Making small changes: Use edit tool
- Appending to files: Use edit tool with context`;

//#endregion

//#region Public API

export type WriteTool = Tool<typeof WriteInputSchema, typeof WriteOutputSchema>;

export function createWriteTool(cwd: string, fs: FsAdapter): WriteTool {
  return tool({
    name: 'Write',
    description: WRITE_TOOL_DESCRIPTION,
    input: WriteInputSchema,
    output: WriteOutputSchema,
    async execute(params) {
      const { path, content } = params;
      const absolutePath = resolveToCwd(path, cwd);
      const dir = dirname(absolutePath);

      try {
        await fs.mkdir(dir);
        await fs.writeFile(absolutePath, content);

        const bytes = Buffer.byteLength(content, 'utf-8');
        return {
          path,
          bytesWritten: bytes,
          success: true,
          message: `Successfully wrote ${bytes} bytes to ${path}`,
        };
      } catch (e) {
        return {
          path,
          bytesWritten: 0,
          success: false,
          message: e instanceof Error ? e.message : String(e),
        };
      }
    },
  });
}

//#endregion
