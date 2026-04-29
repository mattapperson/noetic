/**
 * Edit tool — find-and-replace exact text in files.
 *
 * Ported from: https://github.com/OpenRouterTeam/sky
 */

import type { FsAdapter, Tool } from '@noetic/core';
import { getToolCwd, tool } from '@noetic/core';
import { z } from 'zod';
import {
  applyReplacement,
  detectLineEnding,
  generateDiffString,
  normalizeToLf,
  restoreLineEndings,
  stripBom,
} from './edit-diff.js';
import type { MutationPolicy } from './mutation-policy.js';
import { resolveToCwd } from './path-utils.js';

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

//#region Tool Description

const EDIT_TOOL_DESCRIPTION = `Replace exact text in a file with new text.

CRITICAL: You MUST use the Read tool to view the file before editing. Edits will fail or produce wrong results if the file hasn't been read in the current session.

Usage notes:
 - \`oldText\` must match EXACTLY, including whitespace and indentation.
 - When copying text from Read output, strip the line-number prefix (leading spaces + line number + tab) and preserve the exact indentation that follows it.
 - If \`oldText\` appears more than once in the file, add surrounding context lines until the match is unique.
 - \`newText\` must differ from \`oldText\`; otherwise the tool errors.
 - Line endings (LF / CRLF) and BOM are preserved from the original file.
 - This tool performs a single replacement per call. For multiple locations, issue multiple Edit calls.

When NOT to use:
 - Creating a net-new file: use Write.
 - Moving or renaming a file: use Bash (\`mv\`).
 - Large structural rewrites: prefer Write over many Edits.`;

//#endregion

//#region Public API

export type EditTool = Tool<typeof EditInputSchema, typeof EditOutputSchema>;

export function createEditTool(
  cwd: string,
  fs: FsAdapter,
  mutationPolicy?: MutationPolicy,
): EditTool {
  return tool({
    name: 'Edit',
    description: EDIT_TOOL_DESCRIPTION,
    input: EditInputSchema,
    output: EditOutputSchema,
    async execute(params, toolCtx) {
      const { path, oldText, newText } = params;
      const liveCwd = getToolCwd(toolCtx.ctx, cwd);
      const absolutePath = resolveToCwd(path, liveCwd);

      try {
        const decision = await mutationPolicy?.check({
          kind: 'edit',
          cwd: liveCwd,
          path: absolutePath,
        });
        if (decision && !decision.allowed) {
          throw new Error(decision.message);
        }
        const buffer = await fs.readFile(absolutePath).catch((err: unknown) => {
          const isNotFound = err instanceof Error && 'code' in err && err.code === 'ENOENT';
          throw new Error(`${isNotFound ? 'File not found' : 'Cannot read file'}: ${path}`);
        });
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
        await fs.writeFile(absolutePath, finalContent);

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
