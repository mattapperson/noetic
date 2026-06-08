import type {
  ExecutionContext,
  FsAdapter,
  InputMessageItem,
  InputTextPart,
  Item,
  MemoryLayer,
} from '@noetic-tools/types';
import { createMessage, estimateTokens, Slot } from '@noetic-tools/types';

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

function normalizePath(input: string): string {
  const raw = input.length > 0 ? input : '.';
  const absolute = raw.startsWith('/') ? raw : `/${raw}`;
  const parts: string[] = [];
  for (const part of absolute.split('/')) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function resolvePath(base: string, ref = ''): string {
  return normalizePath(ref.startsWith('/') ? ref : `${base}/${ref}`);
}

function pathBasename(input: string): string {
  const normalized = normalizePath(input);
  if (normalized === '/') {
    return '';
  }
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function pathExtname(input: string): string {
  const name = pathBasename(input);
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(idx) : '';
}

function isAbsolutePath(input: string): boolean {
  return input.startsWith('/');
}

function currentWorkingDirectory(): string {
  return typeof process !== 'undefined' ? process.cwd() : '/';
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

type TextOnlyInputMessage = Omit<InputMessageItem, 'content'> & {
  readonly content: InputTextPart[];
};

function isInputTextPart(value: unknown): value is InputTextPart {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'input_text' &&
    'text' in value &&
    typeof value.text === 'string'
  );
}

function isInputMessage(item: Item): item is TextOnlyInputMessage {
  return (
    item.type === 'message' &&
    'role' in item &&
    'content' in item &&
    Array.isArray(item.content) &&
    item.content.every(isInputTextPart)
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
    const normalizedBase = resolvePath(opts.baseDir);
    const normalizedPath = resolvePath(absolutePath);
    if (!normalizedPath.startsWith(`${normalizedBase}/`) && normalizedPath !== normalizedBase) {
      return {
        content: null,
        deleted: false,
        error: 'PATH_TRAVERSAL: File outside allowed directory',
      };
    }

    // Security: Check file extension
    const ext = pathExtname(normalizedPath).toLowerCase();
    const basename = pathBasename(normalizedPath);
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
    if (pathLower.includes(queryLower) || queryLower.includes(pathBasename(pathLower))) {
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

//#region Layer Hooks

interface FileReferenceRuntime {
  baseDir: string;
  slot: number;
  scoringModel: string;
  readOpts: ReadFileOptions;
}

function createFileReferenceRuntime(opts?: FileReferenceOptions): FileReferenceRuntime {
  const baseDir = opts?.baseDir ?? currentWorkingDirectory();
  const maxFileSize = opts?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const followSymlinks = opts?.followSymlinks ?? false;
  const allowedExtensions = opts?.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS;
  return {
    baseDir,
    slot: opts?.slot ?? Slot.RAG,
    scoringModel: opts?.scoringModel ?? 'anthropic/claude-haiku-4-5-20251001',
    readOpts: {
      maxFileSize,
      followSymlinks,
      baseDir,
      allowedExtensions,
    },
  };
}

async function initFileReferenceState(baseDir: string): Promise<{
  state: FileReferenceState;
}> {
  return {
    state: {
      files: new Map<string, TrackedFile>(),
      baseDir,
    },
  };
}

function absolutePathReference(ref: string): TrackedFile {
  return {
    absolutePath: ref,
    referencePath: ref,
    content: null,
    priority: 0,
    contentHash: '',
    deleted: false,
    tokenCount: 0,
    error: 'ABSOLUTE_PATH: Only relative paths are allowed',
  };
}

async function trackNewReference(args: {
  ref: string;
  state: FileReferenceState;
  readOpts: ReadFileOptions;
  ctx: ExecutionContext;
  userQuery: string;
  scoringModel: string;
}): Promise<TrackedFile> {
  if (isAbsolutePath(args.ref)) {
    return absolutePathReference(args.ref);
  }
  const absolutePath = resolvePath(args.state.baseDir, args.ref);
  const result = await readFileContent(absolutePath, args.readOpts, args.ctx.fs);
  const priority = result.content
    ? await scoreFileRelevance({
        filePath: args.ref,
        fileContent: result.content,
        userQuery: args.userQuery,
        ctx: args.ctx,
        model: args.scoringModel,
      })
    : 0;
  return {
    absolutePath,
    referencePath: args.ref,
    content: result.content,
    priority,
    contentHash: result.content ? simpleHash(result.content) : '',
    deleted: result.deleted,
    tokenCount: result.content ? estimateTokens(result.content) : 0,
    error: result.error,
  };
}

async function addNewReferences(args: {
  refs: ReadonlyArray<string>;
  files: Map<string, TrackedFile>;
  state: FileReferenceState;
  readOpts: ReadFileOptions;
  ctx: ExecutionContext;
  userQuery: string;
  scoringModel: string;
}): Promise<boolean> {
  let hasChanges = false;
  for (const ref of args.refs) {
    if (args.files.has(ref)) {
      continue;
    }
    args.files.set(
      ref,
      await trackNewReference({
        ...args,
        ref,
      }),
    );
    hasChanges = true;
  }
  return hasChanges;
}

function transformItemReferences(item: Item, refs: ReadonlyArray<string>): Item {
  if (refs.length === 0 || !isInputMessage(item)) {
    return item;
  }
  const transformedContent: InputTextPart[] = item.content.map((c) => ({
    type: 'input_text',
    text: transformReferencesToAnchors(c.text),
  }));
  return {
    ...item,
    content: transformedContent,
  } satisfies InputMessageItem;
}

async function processAppendedItems(args: {
  items: Item[];
  files: Map<string, TrackedFile>;
  state: FileReferenceState;
  readOpts: ReadFileOptions;
  ctx: ExecutionContext;
  scoringModel: string;
}): Promise<{
  transformedItems: Item[];
  hasChanges: boolean;
  userQuery: string;
}> {
  const transformedItems: Item[] = [];
  let hasChanges = false;
  let userQuery = '';
  for (const item of args.items) {
    const text = extractTextFromItem(item);
    if (!text) {
      transformedItems.push(item);
      continue;
    }
    if (item.type === 'message' && 'role' in item && item.role === 'user') {
      userQuery = text;
    }
    const refs = extractFileReferences(text);
    const added = await addNewReferences({
      refs,
      files: args.files,
      state: args.state,
      readOpts: args.readOpts,
      ctx: args.ctx,
      userQuery,
      scoringModel: args.scoringModel,
    });
    hasChanges = hasChanges || added;
    transformedItems.push(transformItemReferences(item, refs));
  }
  return {
    transformedItems,
    hasChanges,
    userQuery,
  };
}

async function refreshTrackedFile(args: {
  ref: string;
  tracked: TrackedFile;
  readOpts: ReadFileOptions;
  ctx: ExecutionContext;
  userQuery: string;
  scoringModel: string;
}): Promise<TrackedFile | null> {
  if (args.tracked.error) {
    return null;
  }
  const result = await readFileContent(args.tracked.absolutePath, args.readOpts, args.ctx.fs);
  if (result.deleted && !args.tracked.deleted) {
    return {
      ...args.tracked,
      content: null,
      deleted: true,
    };
  }
  if (result.error && !args.tracked.error) {
    return {
      ...args.tracked,
      content: null,
      error: result.error,
    };
  }
  if (result.deleted || !result.content) {
    return null;
  }
  const newHash = simpleHash(result.content);
  if (newHash === args.tracked.contentHash) {
    return null;
  }
  const priority = args.userQuery
    ? await scoreFileRelevance({
        filePath: args.ref,
        fileContent: result.content,
        userQuery: args.userQuery,
        ctx: args.ctx,
        model: args.scoringModel,
      })
    : args.tracked.priority;
  return {
    ...args.tracked,
    content: result.content,
    contentHash: newHash,
    deleted: false,
    tokenCount: estimateTokens(result.content),
    priority,
    error: undefined,
  };
}

async function refreshTrackedFiles(args: {
  files: Map<string, TrackedFile>;
  readOpts: ReadFileOptions;
  ctx: ExecutionContext;
  userQuery: string;
  scoringModel: string;
}): Promise<boolean> {
  let hasChanges = false;
  for (const [ref, tracked] of args.files) {
    const next = await refreshTrackedFile({
      ...args,
      ref,
      tracked,
    });
    if (next === null) {
      continue;
    }
    args.files.set(ref, next);
    hasChanges = true;
  }
  return hasChanges;
}

async function onFileReferenceItemAppend(
  args: {
    items: Item[];
    ctx: ExecutionContext;
    state: FileReferenceState;
  },
  runtime: FileReferenceRuntime,
) {
  const newFiles = new Map(args.state.files);
  const currentReadOpts: ReadFileOptions = {
    ...runtime.readOpts,
    baseDir: args.state.baseDir,
  };
  const processed = await processAppendedItems({
    items: args.items,
    files: newFiles,
    state: args.state,
    readOpts: currentReadOpts,
    ctx: args.ctx,
    scoringModel: runtime.scoringModel,
  });
  const refreshed = await refreshTrackedFiles({
    files: newFiles,
    readOpts: currentReadOpts,
    ctx: args.ctx,
    userQuery: processed.userQuery,
    scoringModel: runtime.scoringModel,
  });
  return {
    items: processed.transformedItems,
    state: {
      ...args.state,
      files: newFiles,
    },
    rerender: processed.hasChanges || refreshed,
    timing: 'immediate' as const,
    scope: 'self' as const,
  };
}

function buildDeletedOrErrorBlock(file: TrackedFile): string | null {
  if (file.deleted) {
    return `## ${file.referencePath}\n\n[FILE DELETED: ${file.absolutePath}]`;
  }
  if (file.error) {
    return `## ${file.referencePath}\n\n[ERROR: ${file.error}]`;
  }
  return null;
}

function truncateFileContent(file: TrackedFile, remainingBudget: number): string {
  if (!file.content || file.tokenCount <= remainingBudget) {
    return file.content ?? '';
  }
  const lines = file.content.split('\n');
  const headLines = Math.floor(lines.length * 0.6);
  const tailLines = Math.floor(lines.length * 0.3);
  const head = lines.slice(0, headLines).join('\n');
  const tail = lines.slice(-tailLines).join('\n');
  return `${head}\n\n... [truncated ${lines.length - headLines - tailLines} lines] ...\n\n${tail}`;
}

function buildContentBlock(file: TrackedFile, totalTokens: number, budget: number): string | null {
  const statusBlock = buildDeletedOrErrorBlock(file);
  if (statusBlock !== null) {
    return totalTokens + estimateTokens(statusBlock) <= budget ? statusBlock : null;
  }
  if (!file.content) {
    return null;
  }
  const header = `## ${file.referencePath}`;
  const headerTokens = estimateTokens(header);
  if (totalTokens + headerTokens >= budget) {
    return null;
  }
  const remainingBudget = budget - totalTokens - headerTokens - 10;
  const contentToInclude = truncateFileContent(file, remainingBudget);
  return `${header}\n\n\`\`\`\n${contentToInclude}\n\`\`\``;
}

async function recallFileReferences({
  state,
  budget,
}: {
  state: FileReferenceState;
  budget: number;
}) {
  if (state.files.size === 0) {
    return {
      items: [],
      tokenCount: 0,
    };
  }
  const sortedFiles = [
    ...state.files.values(),
  ].sort((a, b) => b.priority - a.priority);
  const blocks: string[] = [];
  let totalTokens = 0;
  for (const file of sortedFiles) {
    const block = buildContentBlock(file, totalTokens, budget);
    if (block === null) {
      continue;
    }
    const blockTokens = estimateTokens(block);
    blocks.push(block);
    totalTokens += blockTokens;
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
  const runtime = createFileReferenceRuntime(opts);
  return {
    id: 'file-reference',
    name: 'File Reference',
    slot: runtime.slot,
    scope: 'thread',
    budget: 'auto',
    rerenderTiming: 'immediate',
    hooks: {
      init: () => initFileReferenceState(runtime.baseDir),
      onItemAppend: (args) => onFileReferenceItemAppend(args, runtime),
      recall: recallFileReferences,
    },
  } satisfies MemoryLayer<FileReferenceState>;
}

//#endregion
