/**
 * Write tool — write content to a file.
 *
 * Ported from: https://github.com/OpenRouterTeam/sky
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ToolWithExecute } from '@openrouter/sdk';
import { tool } from '@openrouter/sdk';
import { z } from 'zod';
import { resolveToCwd } from './path-utils.js';

//#region Types

export interface WriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}

//#endregion

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

//#region Default Operations

const defaultWriteOperations: WriteOperations = {
  writeFile: (absolutePath, content) => writeFile(absolutePath, content, 'utf-8'),
  mkdir: (dir) =>
    mkdir(dir, {
      recursive: true,
    }).then(() => undefined),
};

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

export interface WriteToolOptions {
  operations?: WriteOperations;
}

export type WriteTool = ToolWithExecute<typeof WriteInputSchema, typeof WriteOutputSchema>;

export function createWriteTool(cwd: string, options?: WriteToolOptions): WriteTool {
  const ops = options?.operations ?? defaultWriteOperations;

  return tool({
    name: 'Write',
    description: WRITE_TOOL_DESCRIPTION,
    inputSchema: WriteInputSchema,
    outputSchema: WriteOutputSchema,
    async execute(params) {
      const { path, content } = params;
      const absolutePath = resolveToCwd(path, cwd);
      const dir = dirname(absolutePath);

      try {
        await ops.mkdir(dir);
        await ops.writeFile(absolutePath, content);

        return {
          path,
          bytesWritten: content.length,
          success: true,
          message: `Successfully wrote ${content.length} bytes to ${path}`,
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
