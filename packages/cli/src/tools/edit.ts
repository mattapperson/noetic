/**
 * Edit tool — find-and-replace exact text in files.
 *
 * Ported from: https://github.com/OpenRouterTeam/sky
 */

import { constants } from 'node:fs';
import { access as fsAccess, readFile, writeFile } from 'node:fs/promises';
import { tool } from '@noetic/core';
import type { Tool } from '@noetic/core';
import { z } from 'zod';
import {
  applyReplacement,
  detectLineEnding,
  generateDiffString,
  normalizeToLf,
  restoreLineEndings,
  stripBom,
} from './edit-diff.js';
import { resolveToCwd } from './path-utils.js';

//#region Types

export interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}

//#endregion

//#region Schemas

const EditInputSchema = z.object({
  path: z.string().describe('Path to the file to edit (relative or absolute)'),
  oldText: z.string().describe('Exact text to find and replace (must match exactly)'),
  newText: z.string().describe('New text to replace the old text with'),
});

export const EditOutputSchema = z.object({
  path: z.string().describe('The file path that was edited'),
  success: z.boolean().describe('Whether the edit succeeded'),
  message: z.string().describe('Status message'),
  diff: z.string().optional().describe('Unified diff of the changes made'),
  firstChangedLine: z.number().optional().describe('Line number of first change'),
});

export type EditOutput = z.infer<typeof EditOutputSchema>;

//#endregion

//#region Default Operations

const defaultEditOperations: EditOperations = {
  readFile: (absolutePath) => readFile(absolutePath),
  writeFile: (absolutePath, content) => writeFile(absolutePath, content, 'utf-8'),
  access: (absolutePath) => fsAccess(absolutePath, constants.R_OK | constants.W_OK),
};

//#endregion

//#region Tool Description

const EDIT_TOOL_DESCRIPTION = `Replace exact text in a file with new text.

IMPORTANT: You must use the read tool first to view the file before editing.

Usage notes:
- The oldText must match EXACTLY, including whitespace and indentation
- When copying text from read output, preserve exact indentation after line numbers
- The line number prefix format is: spaces + line number + tab - don't include this in oldText
- If oldText appears multiple times, provide more context to make it unique

Parameters:
- path: File path to edit
- oldText: Exact text to find (must be unique in file)
- newText: Replacement text (must be different from oldText)

When to use:
- Making targeted changes to existing files
- Fixing bugs in specific code sections
- Updating configuration values

When NOT to use:
- Creating new files: Use write tool
- Moving files: Use bash with mv
- Large rewrites: Consider write tool instead`;

//#endregion

//#region Public API

export interface EditToolOptions {
  operations?: EditOperations;
}

export type EditTool = Tool<typeof EditInputSchema, typeof EditOutputSchema>;

export function createEditTool(cwd: string, options?: EditToolOptions): EditTool {
  const ops = options?.operations ?? defaultEditOperations;

  return tool({
    name: 'Edit',
    description: EDIT_TOOL_DESCRIPTION,
    input: EditInputSchema,
    output: EditOutputSchema,
    async execute(params) {
      const { path, oldText, newText } = params;
      const absolutePath = resolveToCwd(path, cwd);

      try {
        try {
          await ops.access(absolutePath);
        } catch {
          throw new Error(`File not found: ${path}`);
        }

        const buffer = await ops.readFile(absolutePath);
        const rawContent = buffer.toString('utf-8');
        const { bom, text: content } = stripBom(rawContent);

        const originalEnding = detectLineEnding(content);
        const normalizedContent = normalizeToLf(content);
        const normalizedOldText = normalizeToLf(oldText);
        const normalizedNewText = normalizeToLf(newText);

        const replacement = applyReplacement({
          normalizedContent,
          normalizedOldText,
          normalizedNewText,
          path,
        });

        if ('error' in replacement) {
          throw new Error(replacement.error);
        }

        const finalContent = bom + restoreLineEndings(replacement.newContent, originalEnding);
        await ops.writeFile(absolutePath, finalContent);

        const diffResult = generateDiffString(normalizedContent, replacement.newContent);

        return {
          path,
          success: true,
          message: `Successfully replaced text in ${path}.`,
          diff: diffResult.diff,
          firstChangedLine: diffResult.firstChangedLine,
        };
      } catch (e) {
        return {
          path,
          success: false,
          message: e instanceof Error ? e.message : String(e),
        };
      }
    },
  });
}

//#endregion
