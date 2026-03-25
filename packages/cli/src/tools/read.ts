/**
 * Read tool — read file contents from the filesystem.
 *
 * Ported from: https://github.com/OpenRouterTeam/sky
 */

import { constants } from 'node:fs';
import { access as fsAccess, readFile } from 'node:fs/promises';
import type { ToolWithExecute } from '@openrouter/sdk';
import { tool } from '@openrouter/sdk';
import { z } from 'zod';
import { resolveReadPath } from './path-utils.js';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from './truncate.js';

//#region Types

type ImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface ReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
  detectImageMimeType?: (absolutePath: string) => Promise<ImageMimeType | null | undefined>;
}

//#endregion

//#region Schemas

const ReadInputSchema = z.object({
  path: z.string().describe('Path to the file to read (relative or absolute)'),
  offset: z.number().optional().describe('Line number to start reading from (1-indexed)'),
  limit: z.number().optional().describe('Maximum number of lines to read'),
});

export const ReadOutputSchema = z.object({
  content: z.string().describe('File content or error message'),
  path: z.string().describe('The file path that was read'),
  isImage: z.boolean().describe('Whether the file is an image'),
  truncated: z.boolean().describe('Whether content was truncated'),
  totalLines: z.number().optional().describe('Total lines in file (text files only)'),
  startLine: z.number().optional().describe('First line number shown (1-indexed)'),
  endLine: z.number().optional().describe('Last line number shown (1-indexed)'),
});

export type ReadOutput = z.infer<typeof ReadOutputSchema>;

//#endregion

//#region Default Operations

const IMAGE_MIME_MAP: Record<string, ImageMimeType> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

function detectImageMimeTypeFromExtension(absolutePath: string): ImageMimeType | null {
  const ext = absolutePath.toLowerCase().split('.').pop();
  return IMAGE_MIME_MAP[ext ?? ''] ?? null;
}

const defaultReadOperations: ReadOperations = {
  readFile: (absolutePath) => readFile(absolutePath),
  access: (absolutePath) => fsAccess(absolutePath, constants.R_OK),
  detectImageMimeType: async (absolutePath) => detectImageMimeTypeFromExtension(absolutePath),
};

//#endregion

//#region Tool Description

const READ_TOOL_DESCRIPTION = `Read file contents from the filesystem.

Usage notes:
- Path can be relative to cwd or absolute
- Images (jpg, png, gif, webp) are detected and noted
- Text files return numbered lines for reference in edit tool
- Output truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever first)
- Use offset/limit for large files

Parameters:
- path: File path (relative or absolute)
- offset: Start line number (1-indexed, optional)
- limit: Max lines to read (optional)

When to use:
- Reading file contents before editing
- Viewing images
- Understanding file structure

When NOT to use:
- Searching within files: Use grep tool
- Finding files by name: Use find tool
- Listing directory contents: Use ls tool`;

//#endregion

//#region Helpers

function buildImageResult(path: string, buffer: Buffer, mimeType: ImageMimeType): ReadOutput {
  const base64 = buffer.toString('base64');
  return {
    content: `Read image file [${mimeType}]\nBase64 data: ${base64.slice(0, 1e2)}...`,
    path,
    isImage: true,
    truncated: false,
  };
}

function buildOffsetError(path: string, offset: number, totalLines: number): ReadOutput {
  return {
    content: `Error: Offset ${offset} is beyond end of file (${totalLines} lines total)`,
    path,
    isImage: false,
    truncated: false,
    totalLines,
  };
}

interface BuildTextResultParams {
  path: string;
  selectedContent: string;
  allLines: string[];
  startLine: number;
  totalLines: number;
  limit: number | undefined;
}

function buildTextResult(params: BuildTextResultParams): ReadOutput {
  const { path, selectedContent, allLines, startLine, totalLines, limit } = params;
  const startLineDisplay = startLine + 1;

  const truncation = truncateHead(selectedContent);
  let content = truncation.content;
  const truncated = truncation.truncated;
  let endLineDisplay =
    limit !== undefined ? Math.min(startLine + limit, allLines.length) : allLines.length;

  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], 'utf-8'));
    content = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
  } else if (truncated) {
    const actualEndLine = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = actualEndLine + 1;
    content +=
      truncation.truncatedBy === 'lines'
        ? `\n\n[Showing lines ${startLineDisplay}-${actualEndLine} of ${totalLines}. Use offset=${nextOffset} to continue]`
        : `\n\n[Showing lines ${startLineDisplay}-${actualEndLine} of ${totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue]`;
    endLineDisplay = actualEndLine;
  } else if (limit !== undefined && startLine + limit < allLines.length) {
    const remaining = allLines.length - (startLine + limit);
    const nextOffset = startLine + limit + 1;
    content += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue]`;
  }

  return {
    content,
    path,
    isImage: false,
    truncated,
    totalLines,
    startLine: startLineDisplay,
    endLine: endLineDisplay,
  };
}

//#endregion

//#region Public API

export interface ReadToolOptions {
  operations?: ReadOperations;
}

export type ReadTool = ToolWithExecute<typeof ReadInputSchema, typeof ReadOutputSchema>;

export function createReadTool(cwd: string, options?: ReadToolOptions): ReadTool {
  const ops = options?.operations ?? defaultReadOperations;

  return tool({
    name: 'Read',
    description: READ_TOOL_DESCRIPTION,
    inputSchema: ReadInputSchema,
    outputSchema: ReadOutputSchema,
    async execute(params) {
      const { path, offset, limit } = params;
      const absolutePath = resolveReadPath(path, cwd);

      try {
        await ops.access(absolutePath);

        const mimeType = ops.detectImageMimeType
          ? await ops.detectImageMimeType(absolutePath)
          : undefined;

        if (mimeType) {
          const buffer = await ops.readFile(absolutePath);
          return buildImageResult(path, buffer, mimeType);
        }

        const buffer = await ops.readFile(absolutePath);
        const textContent = buffer.toString('utf-8');
        const allLines = textContent.split('\n');
        const totalLines = allLines.length;

        const startLine = offset ? Math.max(0, offset - 1) : 0;
        if (startLine >= allLines.length) {
          return buildOffsetError(path, offset!, totalLines);
        }

        const selectedContent =
          limit !== undefined
            ? allLines.slice(startLine, Math.min(startLine + limit, allLines.length)).join('\n')
            : allLines.slice(startLine).join('\n');

        return buildTextResult({
          path,
          selectedContent,
          allLines,
          startLine,
          totalLines,
          limit,
        });
      } catch (e) {
        return {
          content: e instanceof Error ? e.message : String(e),
          path,
          isImage: false,
          truncated: false,
        };
      }
    },
  });
}

//#endregion
