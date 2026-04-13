import * as path from 'node:path';
import { createMessage, estimateTokens } from '../../interpreter/message-helpers';
import type { FsAdapter } from '../../types/fs-adapter';
import type { InputMessageItem, InputTextPart, Item } from '../../types/items';
import type { ExecutionContext, MemoryLayer } from '../../types/memory';
import { Slot } from '../../types/memory';

//#region Types

interface TrackedFile {
  /** Absolute path to the file */
  absolutePath: string;
  /** Original reference path (as written by user) */
  referencePath: string;
  /** File content (null if deleted or error) */
  content: string | null;
  /** LLM-assigned priority score (0-100, higher = more relevant) */
  priority: number;
  /** Content hash for change detection */
  contentHash: string;
  /** Whether the file has been deleted */
  deleted: boolean;
  /** Estimated token count */
  tokenCount: number;
  /** Error message if file couldn't be read (security, size, permission) */
  error?: string;
}

interface FileReferenceState {
  /** Map of reference path to tracked file info */
  files: Map<string, TrackedFile>;
  /** Base directory for resolving relative paths */
  baseDir: string;
}

interface FileReferenceOptions {
  /** Base directory for resolving relative paths (defaults to cwd) */
  baseDir?: string;
  /** Slot position (defaults to Slot.RAG) */
  slot?: number;
  /** Model to use for priority scoring */
  scoringModel?: string;
  /** Maximum file size in bytes (defaults to 1MB) */
  maxFileSize?: number;
  /** Whether to follow symlinks (defaults to false for security) */
  followSymlinks?: boolean;
  /** Allowed file extensions (defaults to common code/text extensions) */
  allowedExtensions?: string[];
}

/** Default max file size: 1MB */
const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;

/** Default allowed extensions */
const DEFAULT_ALLOWED_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.md',
  '.mdx',
  '.txt',
  '.csv',
  '.html',
  '.css',
  '.scss',
  '.less',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.sh',
  '.bash',
  '.zsh',
  '.sql',
  '.graphql',
  '.xml',
  '.svg',
  '.env',
  '.env.local',
  '.env.example',
  '.gitignore',
  '.dockerignore',
  'Dockerfile',
  'Makefile',
  'Taskfile',
];

//#endregion

//#region Helpers

// Pattern requires file-like structure: path with extension or explicit path separator
// Avoids matching #hashtag, #123, #region, etc.
const FILE_REF_PATTERN = /#((?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)/g;

function sanitizeAnchor(refPath: string): string {
  return refPath.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
}

function transformReferencesToAnchors(text: string): string {
  return text.replace(FILE_REF_PATTERN, (_match, filePath: string) => {
    const anchor = sanitizeAnchor(filePath);
    return `[#${filePath}](#${anchor})`;
  });
}

function extractFileReferences(text: string): string[] {
  const refs: string[] = [];
  const pattern = new RegExp(FILE_REF_PATTERN);
  let match = pattern.exec(text);
  while (match !== null) {
    refs.push(match[1]);
    match = pattern.exec(text);
  }
  return [
    ...new Set(refs),
  ]; // Dedupe
}

function simpleHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  // Include content length to reduce collision probability
  return `${content.length}:${hash.toString(16)}`;
}

function isInputMessage(item: Item): item is InputMessageItem {
  return (
    item.type === 'message' &&
    'role' in item &&
    'content' in item &&
    Array.isArray(item.content) &&
    item.content.every(
      (c: unknown) => typeof c === 'object' && c !== null && 'type' in c && c.type === 'input_text',
    )
  );
}

function extractTextFromItem(item: Item): string {
  if (!isInputMessage(item)) {
    return '';
  }
  return item.content.map((c) => c.text).join('\n');
}

interface ReadFileOptions {
  maxFileSize: number;
  followSymlinks: boolean;
  baseDir: string;
  allowedExtensions: string[];
}

interface ReadFileResult {
  content: string | null;
  deleted: boolean;
  error?: string;
}

async function readFileContent(
  absolutePath: string,
  opts: ReadFileOptions,
  fsAdapter: FsAdapter,
): Promise<ReadFileResult> {
  try {
    // Security: Validate path stays within baseDir (prevent path traversal)
    const normalizedBase = path.resolve(opts.baseDir);
    const normalizedPath = path.resolve(absolutePath);
    if (
      !normalizedPath.startsWith(normalizedBase + path.sep) &&
      normalizedPath !== normalizedBase
    ) {
      return {
        content: null,
        deleted: false,
        error: 'PATH_TRAVERSAL: File outside allowed directory',
      };
    }

    // Security: Check file extension
    const ext = path.extname(normalizedPath).toLowerCase();
    const basename = path.basename(normalizedPath);
    const isAllowedExt = opts.allowedExtensions.some(
      (allowed) => ext === allowed.toLowerCase() || basename === allowed,
    );
    if (!isAllowedExt && opts.allowedExtensions.length > 0) {
      return {
        content: null,
        deleted: false,
        error: `DISALLOWED_EXTENSION: ${ext || 'no extension'}`,
      };
    }

    // Security: Check for symlinks if not allowed
    const stats = await fsAdapter.lstat(absolutePath);
    if (stats.isSymbolicLink() && !opts.followSymlinks) {
      return {
        content: null,
        deleted: false,
        error: 'SYMLINK: Symlinks not allowed',
      };
    }

    // Security: Check file size
    const fileStats = opts.followSymlinks ? await fsAdapter.stat(absolutePath) : stats;
    if (fileStats.size > opts.maxFileSize) {
      return {
        content: null,
        deleted: false,
        error: `FILE_TOO_LARGE: ${fileStats.size} bytes exceeds limit of ${opts.maxFileSize}`,
      };
    }

    const content = await fsAdapter.readFileText(absolutePath);
    return {
      content,
      deleted: false,
    };
  } catch (e) {
    if (isNodeError(e) && e.code === 'ENOENT') {
      return {
        content: null,
        deleted: true,
      };
    }
    if (isNodeError(e) && e.code === 'EACCES') {
      return {
        content: null,
        deleted: false,
        error: 'PERMISSION_DENIED: Cannot read file',
      };
    }
    throw e;
  }
}

function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e;
}

function extractResponseText(items: Item[]): string {
  const texts: string[] = [];
  for (const item of items) {
    if (item.type !== 'message') {
      continue;
    }
    if (!('content' in item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if ('text' in part && typeof part.text === 'string') {
        texts.push(part.text);
      }
    }
  }
  return texts.join('').trim();
}

interface ScoreFileRelevanceParams {
  filePath: string;
  fileContent: string;
  userQuery: string;
  ctx: ExecutionContext;
  model: string;
}

async function scoreFileRelevance(params: ScoreFileRelevanceParams): Promise<number> {
  const { filePath, fileContent, userQuery, ctx, model } = params;

  if (!ctx.callModel) {
    const queryLower = userQuery.toLowerCase();
    const pathLower = filePath.toLowerCase();
    if (pathLower.includes(queryLower) || queryLower.includes(path.basename(pathLower))) {
      return 80;
    }
    return 50;
  }

  const scoringPrompt = `Rate the relevance of this file to the user's query.

User Query: ${userQuery}

File Path: ${filePath}
File Content (first 2000 chars):
${fileContent.slice(0, 2e3)}

Respond with ONLY a number from 0-100 where:
- 0-20: Not relevant at all
- 21-40: Slightly relevant
- 41-60: Moderately relevant
- 61-80: Highly relevant
- 81-100: Critical/essential

Score:`;

  try {
    const response = await ctx.callModel({
      model,
      items: [
        createMessage(scoringPrompt, 'user'),
      ],
      instructions: 'You are a relevance scorer. Respond with only a number 0-100.',
    });

    const responseText = extractResponseText(response.items);

    const score = Number.parseInt(responseText, 10);
    if (Number.isNaN(score) || score < 0 || score > 100) {
      return 50;
    }
    return score;
  } catch {
    return 50;
  }
}

//#endregion

//#region Layer Factory

/**
 * Creates a memory layer that tracks file references in user messages.
 *
 * Syntax: `#path/to/file` in user messages
 *
 * Behavior:
 * - Transforms references to markdown anchor links `[#path/to/file](#path-to-file)`
 * - Scores file relevance using LLM when first referenced
 * - Injects file contents into context via recall(), ordered by priority
 * - Detects file changes on each new message, triggers immediate re-render
 * - Shows warning for deleted files
 *
 * @public
 */
export function fileReference(opts?: FileReferenceOptions): MemoryLayer<FileReferenceState> {
  const baseDir = opts?.baseDir ?? process.cwd();
  const slot = opts?.slot ?? Slot.RAG;
  const scoringModel = opts?.scoringModel ?? 'anthropic/claude-haiku-4-5-20251001';
  const maxFileSize = opts?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const followSymlinks = opts?.followSymlinks ?? false;
  const allowedExtensions = opts?.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS;

  // Pre-compute read options for reuse
  const readOpts: ReadFileOptions = {
    maxFileSize,
    followSymlinks,
    baseDir,
    allowedExtensions,
  };

  return {
    id: 'file-reference',
    name: 'File Reference',
    slot,
    scope: 'thread',
    budget: 'auto',
    rerenderTiming: 'immediate',

    hooks: {
      async init() {
        return {
          state: {
            files: new Map<string, TrackedFile>(),
            baseDir,
          },
        };
      },

      async onItemAppend({ items, ctx, state }) {
        const newFiles = new Map(state.files);
        let hasChanges = false;
        let userQuery = '';

        // Update readOpts with current state's baseDir
        const currentReadOpts: ReadFileOptions = {
          ...readOpts,
          baseDir: state.baseDir,
        };

        // Process each item
        const transformedItems: Item[] = [];

        for (const item of items) {
          const text = extractTextFromItem(item);
          if (!text) {
            transformedItems.push(item);
            continue;
          }

          // Extract user query for scoring
          if (item.type === 'message' && 'role' in item && item.role === 'user') {
            userQuery = text;
          }

          // Extract file references
          const refs = extractFileReferences(text);

          // Process new references
          for (const ref of refs) {
            if (!newFiles.has(ref)) {
              // Security: Reject absolute paths - all paths must be relative to baseDir
              if (path.isAbsolute(ref)) {
                newFiles.set(ref, {
                  absolutePath: ref,
                  referencePath: ref,
                  content: null,
                  priority: 0,
                  contentHash: '',
                  deleted: false,
                  tokenCount: 0,
                  error: 'ABSOLUTE_PATH: Only relative paths are allowed',
                });
                hasChanges = true;
                continue;
              }

              const absolutePath = path.resolve(state.baseDir, ref);
              const result = await readFileContent(absolutePath, currentReadOpts, ctx.fs);

              const priority = result.content
                ? await scoreFileRelevance({
                    filePath: ref,
                    fileContent: result.content,
                    userQuery,
                    ctx,
                    model: scoringModel,
                  })
                : 0;

              newFiles.set(ref, {
                absolutePath,
                referencePath: ref,
                content: result.content,
                priority,
                contentHash: result.content ? simpleHash(result.content) : '',
                deleted: result.deleted,
                tokenCount: result.content ? estimateTokens(result.content) : 0,
                error: result.error,
              });

              hasChanges = true;
            }
          }

          // Transform references to anchor links
          if (refs.length > 0 && isInputMessage(item)) {
            const transformedContent: InputTextPart[] = item.content.map((c) => {
              const part: InputTextPart = {
                type: 'input_text',
                text: transformReferencesToAnchors(c.text),
              };
              return part;
            });
            const transformedItem: InputMessageItem = {
              ...item,
              content: transformedContent,
            };
            transformedItems.push(transformedItem);
          } else {
            transformedItems.push(item);
          }
        }

        // Check existing files for changes
        for (const [ref, tracked] of newFiles) {
          // Skip files with errors - they won't change
          if (tracked.error) {
            continue;
          }

          const result = await readFileContent(tracked.absolutePath, currentReadOpts, ctx.fs);

          if (result.deleted && !tracked.deleted) {
            // File was deleted
            newFiles.set(ref, {
              ...tracked,
              content: null,
              deleted: true,
            });
            hasChanges = true;
          } else if (result.error && !tracked.error) {
            // File now has error (e.g., permission changed)
            newFiles.set(ref, {
              ...tracked,
              content: null,
              error: result.error,
            });
            hasChanges = true;
          } else if (!result.deleted && result.content) {
            const newHash = simpleHash(result.content);
            if (newHash !== tracked.contentHash) {
              // File content changed
              const priority = userQuery
                ? await scoreFileRelevance({
                    filePath: ref,
                    fileContent: result.content,
                    userQuery,
                    ctx,
                    model: scoringModel,
                  })
                : tracked.priority;

              newFiles.set(ref, {
                ...tracked,
                content: result.content,
                contentHash: newHash,
                deleted: false,
                tokenCount: estimateTokens(result.content),
                priority,
                error: undefined,
              });
              hasChanges = true;
            }
          }
        }

        return {
          items: transformedItems,
          state: {
            ...state,
            files: newFiles,
          },
          rerender: hasChanges,
          timing: 'immediate',
          scope: 'self',
        };
      },

      async recall({ state, budget }) {
        if (state.files.size === 0) {
          return {
            items: [],
            tokenCount: 0,
          };
        }

        // Sort files by priority (highest first)
        const sortedFiles = [
          ...state.files.values(),
        ].sort((a, b) => b.priority - a.priority);

        // Build content blocks within budget
        const blocks: string[] = [];
        let totalTokens = 0;

        for (const file of sortedFiles) {
          // Handle deleted files
          if (file.deleted) {
            const block = `## ${file.referencePath}\n\n[FILE DELETED: ${file.absolutePath}]`;
            const tokens = estimateTokens(block);
            if (totalTokens + tokens <= budget) {
              blocks.push(block);
              totalTokens += tokens;
            }
            continue;
          }

          // Handle files with errors (security, size, permission)
          if (file.error) {
            const block = `## ${file.referencePath}\n\n[ERROR: ${file.error}]`;
            const tokens = estimateTokens(block);
            if (totalTokens + tokens <= budget) {
              blocks.push(block);
              totalTokens += tokens;
            }
            continue;
          }

          if (!file.content) {
            continue;
          }

          const header = `## ${file.referencePath}`;
          const headerTokens = estimateTokens(header);

          if (totalTokens + headerTokens >= budget) {
            // Can't fit even the header
            break;
          }

          const remainingBudget = budget - totalTokens - headerTokens - 10; // Buffer for formatting
          let contentToInclude = file.content;

          if (file.tokenCount > remainingBudget) {
            // Truncate content - show head + tail
            const lines = file.content.split('\n');
            const headLines = Math.floor(lines.length * 0.6);
            const tailLines = Math.floor(lines.length * 0.3);

            const head = lines.slice(0, headLines).join('\n');
            const tail = lines.slice(-tailLines).join('\n');

            contentToInclude = `${head}\n\n... [truncated ${lines.length - headLines - tailLines} lines] ...\n\n${tail}`;
          }

          const block = `${header}\n\n\`\`\`\n${contentToInclude}\n\`\`\``;
          const blockTokens = estimateTokens(block);

          if (totalTokens + blockTokens <= budget) {
            blocks.push(block);
            totalTokens += blockTokens;
          }
        }

        if (blocks.length === 0) {
          return {
            items: [],
            tokenCount: 0,
          };
        }

        const content = `# Referenced Files\n\n${blocks.join('\n\n')}`;

        return {
          items: [
            createMessage(content, 'developer'),
          ],
          tokenCount: estimateTokens(content),
        };
      },
    },
  } satisfies MemoryLayer<FileReferenceState>;
}

//#endregion
