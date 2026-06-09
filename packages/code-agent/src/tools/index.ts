/**
 * Portable tool exports and factories.
 *
 * This entrypoint is import-safe in browsers, Workers, and isolates. Tools that
 * need Node/Bun capabilities load their implementations lazily and return a
 * clean unsupported-environment result when invoked where they cannot run.
 *
 * The CLI imports `@noetic-tools/code-agent/tools/node` for the full Node/Bun tool
 * implementations.
 */

import type { FsAdapter, ShellAdapter, Tool } from '@noetic-tools/core';
import {
  createInMemoryFsAdapter,
  createInMemoryShellAdapter,
  tool,
} from '@noetic-tools/core/portable';
import { z } from 'zod';
import type { LspService } from '../lsp/service.js';
import { createUnsupportedResult, detectRuntimeCapabilities } from '../runtime-capabilities.js';
import { createRuntimeGeneratorTool, createRuntimeTool } from '../runtime-tool.js';
import { basename, byteLength, joinAdapterPath, resolveAdapterPath } from '../utils.js';
import type { AskUserService } from './ask-user.js';
import { createAskUserTool } from './ask-user.js';
import {
  EDIT_TOOL_NAME,
  FIND_TOOL_NAME,
  GREP_TOOL_NAME,
  LS_TOOL_NAME,
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
} from './constants.js';
import type { MutationPolicy } from './mutation-policy.js';

export {
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  FIND_TOOL_NAME,
  GREP_TOOL_NAME,
  LS_TOOL_NAME,
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
} from './constants.js';
export {
  ALLOW_MUTATION,
  type MutationKind,
  type MutationPolicy,
  type MutationPolicyDecision,
  type MutationPolicyRequest,
} from './mutation-policy.js';

async function loadNodeTools() {
  const capabilities = detectRuntimeCapabilities();
  if (!capabilities.nodeFs) {
    return null;
  }
  return import('./node.js');
}

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

const EditInputSchema = z.object({
  path: z.string().describe('Path to the file to edit'),
  oldText: z.string().describe('Text to replace'),
  newText: z.string().describe('Replacement text'),
});

export const EditOutputSchema = z.object({
  path: z.string().describe('The file path that was edited'),
  success: z.boolean().describe('Whether the edit succeeded'),
  message: z.string().describe('Status message'),
  replacements: z.number().describe('Number of replacements made'),
});

const BashInputSchema = z.object({
  command: z.string().describe('Bash command to execute'),
  timeout: z.number().optional().describe('Timeout in seconds'),
});

export const BashOutputSchema = z.object({
  output: z.string().describe('Command output (stdout + stderr)'),
  command: z.string().describe('The command that was executed'),
  exitCode: z.number().optional().describe('Exit code (undefined if killed)'),
  cancelled: z.boolean().describe('Whether the command was cancelled'),
  truncated: z.boolean().describe('Whether output was truncated'),
  fullOutputPath: z.string().optional().describe('Path to full output if truncated'),
  timeout: z.number().describe('Timeout value used in seconds'),
});

export const BashEventSchema = z.object({
  type: z.literal('progress'),
  partialOutput: z.string().describe('Partial output received so far'),
  bytesReceived: z.number().describe('Total bytes received'),
});

const GrepInputSchema = z.object({
  pattern: z.string().describe('Pattern to search for'),
  path: z.string().optional().describe('Directory or file to search'),
  glob: z.string().optional().describe('Glob filter'),
  ignoreCase: z.boolean().optional().describe('Case-insensitive search'),
  literal: z.boolean().optional().describe('Treat pattern as literal text'),
  context: z.number().optional().describe('Context lines'),
  limit: z.number().optional().describe('Maximum matches'),
});

export const GrepOutputSchema = z.object({
  matches: z.string().describe('Search results with file paths and line numbers'),
  pattern: z.string().describe('The pattern that was searched'),
  matchCount: z.number().describe('Number of matches found'),
  truncated: z.boolean().describe('Whether results were truncated'),
  limitReached: z.boolean().describe('Whether match limit was reached'),
});

const FindInputSchema = z.object({
  pattern: z.string().describe('Glob pattern to match files'),
  path: z.string().optional().describe('Directory to search in'),
  limit: z.number().optional().describe('Maximum number of results'),
});

export const FindOutputSchema = z.object({
  files: z.string().describe('List of matching files'),
  pattern: z.string().describe('The pattern that was searched'),
  fileCount: z.number().describe('Number of files found'),
  truncated: z.boolean().describe('Whether results were truncated'),
  limitReached: z.boolean().describe('Whether result limit was reached'),
});

const LsInputSchema = z.object({
  path: z.string().optional().describe('Directory to list'),
  limit: z.number().optional().describe('Maximum number of entries'),
});

export const LsOutputSchema = z.object({
  entries: z.string().describe('List of entries'),
  path: z.string().describe('The directory that was listed'),
  entryCount: z.number().describe('Number of entries listed'),
  truncated: z.boolean().describe('Whether results were truncated'),
  limitReached: z.boolean().describe('Whether entry limit was reached'),
});

const InteractiveTerminalInputSchema = z.object({
  action: z.string().describe('Interactive terminal action'),
  command: z.string().optional(),
  session: z.string().optional(),
  name: z.string().optional(),
  key: z.string().optional(),
  text: z.string().optional(),
  pattern: z.string().optional(),
  regex: z.boolean().optional(),
  row: z.number().optional(),
  col: z.number().optional(),
  direction: z
    .enum([
      'up',
      'down',
    ])
    .optional(),
  amount: z.number().optional(),
});

export const InteractiveTerminalOutputSchema = z.object({
  output: z.string().describe('Terminal output or error'),
  exitCode: z.number().optional().describe('Process exit code'),
  action: z.string().describe('The action that was attempted'),
  session: z.string().optional().describe('Session reference'),
  truncated: z.boolean().describe('Whether output was truncated'),
});

const BrowserInputSchema = z.object({
  action: z.string().describe('Browser action'),
  url: z.string().optional(),
  ref: z.string().optional(),
  value: z.string().optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  path: z.string().optional(),
  js: z.string().optional(),
  timeoutMs: z.number().optional(),
  all: z.boolean().optional(),
});

export const BrowserOutputSchema = z.object({
  output: z.string().describe('Browser output or error'),
  exitCode: z.number().optional().describe('Process exit code'),
  action: z.string().describe('The action that was attempted'),
  truncated: z.boolean().describe('Whether output was truncated'),
});

const LspInputSchema = z.object({
  operation: z.string().describe('LSP operation'),
  filePath: z.string().describe('File path'),
  line: z.number().int().min(1).describe('1-indexed line number'),
  character: z.number().int().min(0).describe('0-indexed character offset'),
});

export const LspOutputSchema = z.object({
  operation: z.string(),
  results: z.string().describe('Human-readable LSP result or error'),
});

export type ReadOutput = z.infer<typeof ReadOutputSchema>;
export type WriteOutput = z.infer<typeof WriteOutputSchema>;
export type EditOutput = z.infer<typeof EditOutputSchema>;
export type BashOutput = z.infer<typeof BashOutputSchema>;
export type BashEvent = z.infer<typeof BashEventSchema>;
export type GrepOutput = z.infer<typeof GrepOutputSchema>;
export type FindOutput = z.infer<typeof FindOutputSchema>;
export type LsOutput = z.infer<typeof LsOutputSchema>;
export type InteractiveTerminalInput = z.infer<typeof InteractiveTerminalInputSchema>;
export type InteractiveTerminalOutput = z.infer<typeof InteractiveTerminalOutputSchema>;
export type BrowserInput = z.infer<typeof BrowserInputSchema>;
export type BrowserOutput = z.infer<typeof BrowserOutputSchema>;
export type LspOutput = z.infer<typeof LspOutputSchema>;

export type ReadTool = Tool<typeof ReadInputSchema, typeof ReadOutputSchema>;
export type WriteTool = Tool<typeof WriteInputSchema, typeof WriteOutputSchema>;
export type EditTool = Tool<typeof EditInputSchema, typeof EditOutputSchema>;
export type BashTool = Tool<typeof BashInputSchema, typeof BashOutputSchema>;
export type GrepTool = Tool<typeof GrepInputSchema, typeof GrepOutputSchema>;
export type FindTool = Tool<typeof FindInputSchema, typeof FindOutputSchema>;
export type LsTool = Tool<typeof LsInputSchema, typeof LsOutputSchema>;
export type InteractiveTerminalTool = Tool<
  typeof InteractiveTerminalInputSchema,
  typeof InteractiveTerminalOutputSchema
>;
export type BrowserTool = Tool<typeof BrowserInputSchema, typeof BrowserOutputSchema>;
export type LspTool = Tool<typeof LspInputSchema, typeof LspOutputSchema>;

function lazyTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  name: string,
  description: string,
  input: I,
  output: O,
  load: (nodeTools: Awaited<ReturnType<typeof loadNodeTools>>) => Tool | undefined,
  fallback: (params: z.infer<I>) => z.infer<O>,
): Tool<I, O> {
  return createRuntimeTool({
    name,
    description,
    input,
    output,
    async load() {
      const nodeTools = await loadNodeTools();
      return load(nodeTools);
    },
    fallback,
  });
}

function liveCwd(toolCtx: unknown, fallback: string): string {
  if (typeof toolCtx !== 'object' || toolCtx === null || !('ctx' in toolCtx)) {
    return fallback;
  }
  const ctx = toolCtx.ctx;
  if (typeof ctx !== 'object' || ctx === null || !('cwdState' in ctx)) {
    return fallback;
  }
  const cwdState = ctx.cwdState;
  if (typeof cwdState !== 'object' || cwdState === null || !('cwd' in cwdState)) {
    return fallback;
  }
  return typeof cwdState.cwd === 'string' ? cwdState.cwd : fallback;
}

function isGlobMatch(name: string, pattern: string): boolean {
  const globstarSentinel = String.fromCharCode(0);
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, globstarSentinel)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .split(globstarSentinel)
    .join('.*');
  return new RegExp(`^${escaped}$`).test(name);
}

async function walkFiles(fs: FsAdapter, root: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(root);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === '.git' || entry === 'node_modules') {
      continue;
    }
    const relative = prefix ? `${prefix}/${entry}` : entry;
    const full = joinAdapterPath(root, entry);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) {
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...(await walkFiles(fs, full, relative)));
    } else if (stat.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

export function createReadTool(cwd: string, fs: FsAdapter): ReadTool {
  return tool({
    name: READ_TOOL_NAME,
    description: 'Read file contents from the configured filesystem adapter.',
    input: ReadInputSchema,
    output: ReadOutputSchema,
    async execute(params, toolCtx) {
      const path = resolveAdapterPath(liveCwd(toolCtx, cwd), params.path);
      try {
        const content = await fs.readFileText(path);
        const lines = content.split('\n');
        const start = Math.max(0, (params.offset ?? 1) - 1);
        if (start >= lines.length && lines.length > 0) {
          return {
            content: `Error: Offset ${params.offset} is beyond end of file (${lines.length} lines total)`,
            path,
            isImage: false,
            truncated: false,
            totalLines: lines.length,
          };
        }
        const selected =
          params.limit === undefined
            ? lines.slice(start)
            : lines.slice(start, start + params.limit);
        const end = start + selected.length;
        return {
          content: selected.join('\n'),
          path,
          isImage: false,
          truncated: end < lines.length,
          totalLines: lines.length,
          startLine: start + 1,
          endLine: end,
        };
      } catch (err) {
        return {
          content: err instanceof Error ? err.message : String(err),
          path,
          isImage: false,
          truncated: false,
        };
      }
    },
  });
}

export function createWriteTool(
  cwd: string,
  fs: FsAdapter,
  mutationPolicy?: MutationPolicy,
): WriteTool {
  return tool({
    name: WRITE_TOOL_NAME,
    description: 'Write content through the configured filesystem adapter.',
    input: WriteInputSchema,
    output: WriteOutputSchema,
    async execute(params, toolCtx) {
      const path = resolveAdapterPath(liveCwd(toolCtx, cwd), params.path);
      const decision = await mutationPolicy?.check({
        kind: 'write',
        cwd: liveCwd(toolCtx, cwd),
        path,
      });
      if (decision?.allowed === false) {
        return {
          path,
          bytesWritten: 0,
          success: false,
          message: decision.message,
        };
      }
      await fs.writeFile(path, params.content);
      return {
        path,
        bytesWritten: byteLength(params.content),
        success: true,
        message: 'File written',
      };
    },
  });
}

export function createEditTool(
  cwd: string,
  fs: FsAdapter,
  mutationPolicy?: MutationPolicy,
): EditTool {
  return tool({
    name: EDIT_TOOL_NAME,
    description: 'Edit a file through the configured filesystem adapter.',
    input: EditInputSchema,
    output: EditOutputSchema,
    async execute(params, toolCtx) {
      const path = resolveAdapterPath(liveCwd(toolCtx, cwd), params.path);
      const decision = await mutationPolicy?.check({
        kind: 'edit',
        cwd: liveCwd(toolCtx, cwd),
        path,
      });
      if (decision?.allowed === false) {
        return {
          path,
          success: false,
          message: decision.message,
          replacements: 0,
        };
      }
      const content = await fs.readFileText(path);
      if (!content.includes(params.oldText)) {
        return {
          path,
          success: false,
          message: 'Text not found',
          replacements: 0,
        };
      }
      const replacements = content.split(params.oldText).length - 1;
      await fs.writeFile(path, content.split(params.oldText).join(params.newText));
      return {
        path,
        success: true,
        message: 'File edited',
        replacements,
      };
    },
  });
}

export function createBashTool(
  cwd: string,
  shell: ShellAdapter,
  mutationPolicy?: MutationPolicy,
): BashTool {
  return createRuntimeGeneratorTool({
    name: 'Bash',
    description:
      'Execute a shell command in Node/Bun runtimes. Returns unsupported in browsers and isolates.',
    input: BashInputSchema,
    event: BashEventSchema,
    output: BashOutputSchema,
    async load() {
      const nodeTools = await loadNodeTools();
      return nodeTools?.createBashTool(cwd, shell, mutationPolicy);
    },
    fallback(params) {
      return createUnsupportedResult('Bash', (message) => ({
        output: message,
        command: params.command,
        exitCode: undefined,
        cancelled: false,
        truncated: false,
        timeout: params.timeout ?? 120,
      }));
    },
  });
}

export function createGrepTool(cwd: string, fs: FsAdapter, _shell: ShellAdapter): GrepTool {
  return tool({
    name: GREP_TOOL_NAME,
    description: 'Search file contents through the configured filesystem adapter.',
    input: GrepInputSchema,
    output: GrepOutputSchema,
    async execute(params, toolCtx) {
      const root = resolveAdapterPath(liveCwd(toolCtx, cwd), params.path ?? '.');
      const limit = params.limit ?? 100;
      const stat = await fs.stat(root).catch(() => null);
      if (!stat) {
        return {
          matches: `Path not found: ${root}`,
          pattern: params.pattern,
          matchCount: 0,
          truncated: false,
          limitReached: false,
        };
      }
      const files = stat.isDirectory()
        ? await walkFiles(fs, root)
        : [
            basename(root),
          ];
      const matcher = params.literal
        ? (line: string) => line.includes(params.pattern)
        : (line: string) =>
            new RegExp(params.pattern, params.ignoreCase ? 'i' : undefined).test(line);
      const rows: string[] = [];
      for (const relative of files) {
        if (params.glob && !isGlobMatch(relative, params.glob)) {
          continue;
        }
        const full = stat.isDirectory() ? joinAdapterPath(root, relative) : root;
        const text = await fs.readFileText(full).catch(() => '');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (matcher(lines[i] ?? '')) {
            rows.push(`${relative}:${i + 1}: ${lines[i]}`);
            if (rows.length >= limit) {
              return {
                matches: rows.join('\n'),
                pattern: params.pattern,
                matchCount: rows.length,
                truncated: false,
                limitReached: true,
              };
            }
          }
        }
      }
      return {
        matches: rows.length === 0 ? 'No matches found' : rows.join('\n'),
        pattern: params.pattern,
        matchCount: rows.length,
        truncated: false,
        limitReached: false,
      };
    },
  });
}

export function createFindTool(cwd: string, fs: FsAdapter): FindTool {
  return tool({
    name: FIND_TOOL_NAME,
    description: 'Find files by glob pattern through the configured filesystem adapter.',
    input: FindInputSchema,
    output: FindOutputSchema,
    async execute(params, toolCtx) {
      const root = resolveAdapterPath(liveCwd(toolCtx, cwd), params.path ?? '.');
      const limit = params.limit ?? 1000;
      const stat = await fs.stat(root).catch(() => null);
      if (!stat) {
        return {
          files: `Path not found: ${root}`,
          pattern: params.pattern,
          fileCount: 0,
          truncated: false,
          limitReached: false,
        };
      }
      const matches = (await walkFiles(fs, root)).filter((file) =>
        isGlobMatch(file, params.pattern),
      );
      const sliced = matches.slice(0, limit);
      return {
        files: sliced.length === 0 ? 'No files found matching pattern' : sliced.join('\n'),
        pattern: params.pattern,
        fileCount: sliced.length,
        truncated: false,
        limitReached: matches.length > sliced.length,
      };
    },
  });
}

export function createLsTool(cwd: string, fs: FsAdapter): LsTool {
  return tool({
    name: LS_TOOL_NAME,
    description: 'List files and directories through the configured filesystem adapter.',
    input: LsInputSchema,
    output: LsOutputSchema,
    async execute(params, toolCtx) {
      const path = resolveAdapterPath(liveCwd(toolCtx, cwd), params.path ?? '.');
      const limit = params.limit ?? 500;
      const entries = await fs.readdir(path).catch((err) => [
        err instanceof Error ? err.message : String(err),
      ]);
      const formatted = await Promise.all(
        entries.map(async (entry) => {
          const stat = await fs.stat(joinAdapterPath(path, entry)).catch(() => null);
          return stat?.isDirectory() ? `${entry}/` : entry;
        }),
      );
      const sliced = formatted.sort().slice(0, limit);
      return {
        entries: sliced.length === 0 ? '(empty directory)' : sliced.join('\n'),
        path,
        entryCount: sliced.length,
        truncated: false,
        limitReached: formatted.length > sliced.length,
      };
    },
  });
}

export interface CreateInteractiveTerminalOptions {
  readonly?: boolean;
  mutationPolicy?: MutationPolicy;
}

export function createInteractiveTerminalTool(
  cwd: string,
  shell: ShellAdapter,
  options: CreateInteractiveTerminalOptions = {},
): InteractiveTerminalTool {
  return lazyTool(
    'InteractiveTerminal',
    'Drive an interactive terminal in Node/Bun runtimes. Returns unsupported in browsers and isolates.',
    InteractiveTerminalInputSchema,
    InteractiveTerminalOutputSchema,
    (m) => m?.createInteractiveTerminalTool(cwd, shell, options),
    (params) => {
      return createUnsupportedResult('InteractiveTerminal', (message) => ({
        output: message,
        action: params.action,
        session: params.session ?? params.name,
        truncated: false,
      }));
    },
  );
}

export function createBrowserTool(cwd: string, shell: ShellAdapter): BrowserTool {
  return lazyTool(
    'Browser',
    'Drive a browser in Node/Bun runtimes. Returns unsupported in browsers and isolates.',
    BrowserInputSchema,
    BrowserOutputSchema,
    (m) => m?.createBrowserTool(cwd, shell),
    (params) => {
      return createUnsupportedResult('Browser', (message) => ({
        output: message,
        action: params.action,
        truncated: false,
      }));
    },
  );
}

export function createLspTool(service: LspService, cwd: string): LspTool {
  return lazyTool(
    'Lsp',
    'Query language servers in Node/Bun runtimes. Returns unsupported in browsers and isolates.',
    LspInputSchema,
    LspOutputSchema,
    (m) => m?.createLspTool(service, cwd),
    (params) =>
      createUnsupportedResult('Lsp', (message) => ({
        operation: params.operation,
        results: message,
      })),
  );
}

/**
 * Per-tool availability flags. Defaults to every tool enabled so existing
 * callers and tests see no behaviour change; the CLI setup flow passes an
 * explicit map when the user has ignored the binary that backs a tool.
 */
export interface AvailableTools {
  /** When `false`, `InteractiveTerminal` (pilotty-backed) is omitted. */
  interactiveTerminal?: boolean;
  /** When `false`, the `browser` tool (agent-browser-backed) is omitted. */
  browser?: boolean;
}

export interface CreateToolsOptions {
  cwd: string;
  fs?: FsAdapter;
  shell?: ShellAdapter;
  lspService?: LspService;
  askUserService?: AskUserService;
  mutationPolicy?: MutationPolicy;
  /**
   * Gate tools whose external binary may be missing/ignored. Unset flags
   * default to `true` — the tool is registered — so this is purely an
   * opt-out layer.
   */
  availableTools?: AvailableTools;
}

function isEnabled(flag: boolean | undefined): boolean {
  return flag !== false;
}

export function createCodingTools(opts: CreateToolsOptions): Tool[] {
  const { cwd, lspService } = opts;
  const fs = opts.fs ?? createInMemoryFsAdapter();
  const shell = opts.shell ?? createInMemoryShellAdapter();
  const available = opts.availableTools ?? {};
  const tools: Tool[] = [
    createReadTool(cwd, fs),
    createWriteTool(cwd, fs, opts.mutationPolicy),
    createEditTool(cwd, fs, opts.mutationPolicy),
    createBashTool(cwd, shell, opts.mutationPolicy),
    createGrepTool(cwd, fs, shell),
    createFindTool(cwd, fs),
    createLsTool(cwd, fs),
  ];
  if (isEnabled(available.interactiveTerminal)) {
    tools.push(
      createInteractiveTerminalTool(cwd, shell, {
        mutationPolicy: opts.mutationPolicy,
      }),
    );
  }
  if (isEnabled(available.browser)) {
    tools.push(createBrowserTool(cwd, shell));
  }
  if (lspService) {
    tools.push(createLspTool(lspService, cwd));
  }
  if (opts.askUserService) {
    tools.push(createAskUserTool(opts.askUserService));
  }
  return tools;
}

export function createReadOnlyTools(opts: CreateToolsOptions): Tool[] {
  const { cwd, lspService } = opts;
  const fs = opts.fs ?? createInMemoryFsAdapter();
  const shell = opts.shell ?? createInMemoryShellAdapter();
  const available = opts.availableTools ?? {};
  const tools: Tool[] = [
    createReadTool(cwd, fs),
    createGrepTool(cwd, fs, shell),
    createFindTool(cwd, fs),
    createLsTool(cwd, fs),
  ];
  if (isEnabled(available.interactiveTerminal)) {
    tools.push(
      createInteractiveTerminalTool(cwd, shell, {
        readonly: true,
        mutationPolicy: opts.mutationPolicy,
      }),
    );
  }
  if (lspService) {
    tools.push(createLspTool(lspService, cwd));
  }
  if (opts.askUserService) {
    tools.push(createAskUserTool(opts.askUserService));
  }
  return tools;
}
