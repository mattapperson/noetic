/**
 * Filesystem tools — mirrors DeepAgentsJS createFilesystemMiddleware.
 *
 * Real Node.js fs operations with path containment for security.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { z } from 'zod';
import { tool } from '../../../src/builders/tool-builder';
import type { Tool } from '../../../src/types/common';

//#region Helper Functions

function assertContained(rootDir: string, targetPath: string): string {
  const resolved = resolve(rootDir, targetPath);
  if (!resolved.startsWith(resolve(rootDir))) {
    throw new Error(`Path traversal denied: ${targetPath}`);
  }
  return resolved;
}

//#endregion

//#region Tool Definitions

function createLsTool(rootDir: string): Tool {
  return tool({
    name: 'ls',
    description: 'List files and directories at the given path.',
    input: z.object({
      path: z.string().describe('Directory path relative to project root'),
    }),
    output: z.array(
      z.object({
        name: z.string(),
        isDirectory: z.boolean(),
      }),
    ),
    execute: async (
      args,
    ): Promise<
      {
        name: string;
        isDirectory: boolean;
      }[]
    > => {
      const resolved = assertContained(rootDir, args.path);
      const entries = readdirSync(resolved, {
        withFileTypes: true,
      });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }));
    },
  });
}

function createReadFileTool(rootDir: string): Tool {
  return tool({
    name: 'read_file',
    description: 'Read the contents of a file, optionally with offset and limit.',
    input: z.object({
      path: z.string().describe('File path relative to project root'),
      offset: z.number().optional().describe('Starting line number (0-based)'),
      limit: z.number().optional().describe('Number of lines to read'),
    }),
    output: z.string(),
    execute: async (args): Promise<string> => {
      const resolved = assertContained(rootDir, args.path);
      const content = readFileSync(resolved, 'utf-8');
      if (args.offset === undefined && args.limit === undefined) {
        return content;
      }
      const lines = content.split('\n');
      const start = args.offset ?? 0;
      const end = args.limit !== undefined ? start + args.limit : lines.length;
      return lines.slice(start, end).join('\n');
    },
  });
}

function createWriteFileTool(rootDir: string): Tool {
  return tool({
    name: 'write_file',
    description: 'Write content to a file, creating parent directories as needed.',
    input: z.object({
      path: z.string().describe('File path relative to project root'),
      content: z.string().describe('File content to write'),
    }),
    output: z.object({
      path: z.string(),
      bytesWritten: z.number(),
    }),
    execute: async (
      args,
    ): Promise<{
      path: string;
      bytesWritten: number;
    }> => {
      const resolved = assertContained(rootDir, args.path);
      mkdirSync(dirname(resolved), {
        recursive: true,
      });
      writeFileSync(resolved, args.content, 'utf-8');
      return {
        path: relative(rootDir, resolved),
        bytesWritten: Buffer.byteLength(args.content, 'utf-8'),
      };
    },
  });
}

function createEditFileTool(rootDir: string): Tool {
  return tool({
    name: 'edit_file',
    description: 'Replace a string in a file. Fails if the search string is not found.',
    input: z.object({
      path: z.string().describe('File path relative to project root'),
      search: z.string().describe('Exact string to find'),
      replace: z.string().describe('String to replace it with'),
    }),
    output: z.object({
      path: z.string(),
      replacements: z.number(),
    }),
    execute: async (
      args,
    ): Promise<{
      path: string;
      replacements: number;
    }> => {
      const resolved = assertContained(rootDir, args.path);
      const content = readFileSync(resolved, 'utf-8');
      const idx = content.indexOf(args.search);
      if (idx === -1) {
        throw new Error(`Search string not found in ${args.path}`);
      }
      const updated =
        content.slice(0, idx) + args.replace + content.slice(idx + args.search.length);
      writeFileSync(resolved, updated, 'utf-8');
      return {
        path: relative(rootDir, resolved),
        replacements: 1,
      };
    },
  });
}

function createGlobFilesTool(rootDir: string): Tool {
  return tool({
    name: 'glob_files',
    description: 'Find files matching a glob pattern.',
    input: z.object({
      pattern: z.string().describe('Glob pattern (e.g. "**/*.ts")'),
      cwd: z.string().optional().describe('Subdirectory to search from'),
    }),
    output: z.array(z.string()),
    execute: async (args): Promise<string[]> => {
      const searchDir = args.cwd ? assertContained(rootDir, args.cwd) : rootDir;
      const glob = new Bun.Glob(args.pattern);
      const matches: string[] = [];
      for (const path of glob.scanSync({
        cwd: searchDir,
      })) {
        matches.push(path);
      }
      return matches;
    },
  });
}

function createGrepFilesTool(rootDir: string): Tool {
  return tool({
    name: 'grep_files',
    description: 'Search file contents for a pattern using regex.',
    input: z.object({
      pattern: z.string().describe('Regex pattern to search for'),
      path: z.string().optional().describe('File or directory to search (defaults to root)'),
    }),
    output: z.array(
      z.object({
        file: z.string(),
        line: z.number(),
        text: z.string(),
      }),
    ),
    execute: async (
      args,
    ): Promise<
      {
        file: string;
        line: number;
        text: string;
      }[]
    > => {
      const searchPath = args.path ? assertContained(rootDir, args.path) : rootDir;
      const regex = new RegExp(args.pattern);
      const results: {
        file: string;
        line: number;
        text: string;
      }[] = [];

      const glob = new Bun.Glob('**/*');
      for (const filePath of glob.scanSync({
        cwd: searchPath,
      })) {
        const fullPath = resolve(searchPath, filePath);
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push({
                file: relative(rootDir, fullPath),
                line: i + 1,
                text: lines[i],
              });
            }
          }
        } catch {
          // Skip binary/unreadable files
        }
      }
      return results;
    },
  });
}

//#endregion

//#region Public API

export function createFilesystemTools(rootDir: string): Tool[] {
  const resolved = resolve(rootDir);
  return [
    createLsTool(resolved),
    createReadFileTool(resolved),
    createWriteFileTool(resolved),
    createEditFileTool(resolved),
    createGlobFilesTool(resolved),
    createGrepFilesTool(resolved),
  ];
}

//#endregion
