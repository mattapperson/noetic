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

const WRITE_TOOL_DESCRIPTION = `Write content to a file, creating it if it doesn't exist. OVERWRITES the existing file completely.

CRITICAL: If the file already exists you MUST use the Read tool first to view the current contents. Skipping this will silently overwrite uncommitted work.

Usage notes:
 - Creates parent directories automatically if needed.
 - ALWAYS prefer editing an existing file (Edit) over creating a new one.
 - NEVER proactively create documentation files (README.md, CHANGES.md, CHANGELOG.md, etc.) unless the user explicitly requests it.
 - Do not write files outside the cwd without explicit user instruction.

When to use:
 - Creating a net-new file the user has asked for.
 - Completely rewriting a file's contents.

When NOT to use:
 - Small, targeted changes: use Edit.
 - Appending content: use Edit with surrounding context.`;

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
