/**
 * AGENT.md + rules loader.
 *
 * Discovers user-global and project-local instruction files, resolves
 * `@path.md` imports (cycle-safe, depth-limited), executes embedded
 * `!command` lines via `processSkillContent`, truncates each file to a
 * per-file cap, and renders a combined body with `Contents of <path> (<desc>):`
 * headers matching Claude Code's rendering.
 */

import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FsAdapter, ShellAdapter } from '@noetic/core';
import { createLocalShellAdapter } from '@noetic/core';
import { processSkillContent } from '../skills/processor.js';

//#region Types

/** Origin of a discovered instruction file. */
export type AgentInstructionOrigin = 'project' | 'user';

/** Kind of source — affects glob behavior and header wording. */
export type AgentInstructionKind = 'agent-md' | 'rule' | 'nested-pkg';

/** A single discovered instruction file, with contents post-transclusion/post-command. */
export interface AgentInstructionSource {
  /** Absolute path to the source file. */
  path: string;
  /** Path as displayed in the rendered header (uses `~/…` for home-relative paths). */
  displayPath: string;
  origin: AgentInstructionOrigin;
  kind: AgentInstructionKind;
  /** Fixed wording used in the rendered `Contents of … (…)` header. */
  roleDescription: string;
  /** Post-transclusion, post-command-execution, post-truncation text. */
  content: string;
  /** True if content was truncated by the per-file cap. */
  wasTruncated: boolean;
  /** Byte size of the rendered content (utf-8). */
  byteSize: number;
  /** Absolute paths of files transcluded via `@imports` while rendering this source. */
  resolvedImports: ReadonlyArray<string>;
}

/** Aggregate result of a loader invocation. */
export interface AgentInstructionResult {
  /** Combined rendered text with `Contents of <path> (<desc>):` headers. Empty string when no sources found. */
  text: string;
  sources: ReadonlyArray<AgentInstructionSource>;
  /** Sum of `byteSize` across all `sources`. */
  totalBytes: number;
  /** True if the 60KB total cap caused lower-precedence sources to be dropped. */
  totalCapExceeded: boolean;
}

/** Options accepted by `loadAgentInstructions`. */
export interface LoadAgentInstructionsOpts {
  cwd: string;
  /** Defaults to `os.homedir()`. */
  homeDir?: string;
  fs: FsAdapter;
  /** Defaults to `createLocalShellAdapter()`. Used for `!command` processing in user-origin files. */
  shell?: ShellAdapter;
  /** Per-file line cap. Default: 200. */
  maxLinesPerFile?: number;
  /** Per-file byte cap. Default: 25_000. */
  maxBytesPerFile?: number;
  /** Total byte cap across all sources. Default: 60_000. */
  maxTotalBytes?: number;
  /** Max depth of `@import` chains. Default: 5. */
  maxImportDepth?: number;
  /**
   * If `true`, project-origin files execute `!command` lines at load time. Default: `false`.
   * User-origin files (`~/...`) always execute commands (parity with the skills layer).
   */
  trustProjectEmbeddedCommands?: boolean;
}

//#endregion

//#region Constants

const DEFAULT_MAX_LINES_PER_FILE = 200;
const DEFAULT_MAX_BYTES_PER_FILE = 25_000;
const DEFAULT_MAX_TOTAL_BYTES = 60_000;
const DEFAULT_MAX_IMPORT_DEPTH = 5;

const PROJECT_ROLE = 'project instructions, checked into the codebase';
const USER_ROLE = "user's private global instructions for all projects";

const IMPORT_LINE_PATTERN = /^@(\S+\.md)\s*$/gm;

//#endregion

//#region Path helpers

function toDisplayPath(absolutePath: string, homeDir: string): string {
  if (absolutePath === homeDir) {
    return '~';
  }
  const withSep = homeDir.endsWith(sep) ? homeDir : `${homeDir}${sep}`;
  if (absolutePath.startsWith(withSep)) {
    return `~/${relative(homeDir, absolutePath).split(sep).join('/')}`;
  }
  return absolutePath;
}

async function exists(fs: FsAdapter, path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(fs: FsAdapter, path: string): Promise<boolean> {
  try {
    const st = await fs.stat(path);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function readIfExists(fs: FsAdapter, path: string): Promise<string | null> {
  try {
    return await fs.readFileText(path);
  } catch {
    return null;
  }
}

async function listMarkdownFilesSorted(fs: FsAdapter, dir: string): Promise<string[]> {
  if (!(await isDirectory(fs, dir))) {
    return [];
  }
  const entries = await fs.readdir(dir);
  const mdFiles = entries.filter((e) => e.endsWith('.md')).sort();
  return mdFiles.map((e) => join(dir, e));
}

async function findRepoRoot(fs: FsAdapter, startDir: string): Promise<string | null> {
  let current = resolve(startDir);
  while (true) {
    if (await exists(fs, join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

//#endregion

//#region Discovery

interface CandidatePath {
  path: string;
  origin: AgentInstructionOrigin;
  kind: AgentInstructionKind;
}

async function collectCandidates(
  fs: FsAdapter,
  cwd: string,
  homeDir: string,
): Promise<CandidatePath[]> {
  const candidates: CandidatePath[] = [];
  const seen = new Set<string>();
  const push = (path: string, origin: AgentInstructionOrigin, kind: AgentInstructionKind): void => {
    const abs = resolve(path);
    if (seen.has(abs)) {
      return;
    }
    seen.add(abs);
    candidates.push({
      path: abs,
      origin,
      kind,
    });
  };

  // 1. Project root AGENT.md
  push(join(cwd, 'AGENT.md'), 'project', 'agent-md');
  // 2. Project .agent/AGENT.md
  push(join(cwd, '.agent', 'AGENT.md'), 'project', 'agent-md');
  // 3. Project .agent/rules/*.md
  for (const p of await listMarkdownFilesSorted(fs, join(cwd, '.agent', 'rules'))) {
    push(p, 'project', 'rule');
  }
  // 4. Ancestor walk from cwd up to repo root (exclusive of cwd which is already covered).
  const repoRoot = await findRepoRoot(fs, cwd);
  if (repoRoot !== null && repoRoot !== cwd) {
    let current = dirname(cwd);
    const stopAt = dirname(repoRoot);
    while (current !== stopAt && current !== homeDir) {
      push(join(current, 'AGENT.md'), 'project', 'nested-pkg');
      if (current === repoRoot) {
        break;
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  // 5. User XDG AGENT.md
  push(join(homeDir, '.config', 'noetic', 'AGENT.md'), 'user', 'agent-md');
  // 6. User XDG rules
  for (const p of await listMarkdownFilesSorted(fs, join(homeDir, '.config', 'noetic', 'rules'))) {
    push(p, 'user', 'rule');
  }
  // 7. User home fallback AGENT.md
  push(join(homeDir, '.noetic', 'AGENT.md'), 'user', 'agent-md');
  // 8. User home fallback rules
  for (const p of await listMarkdownFilesSorted(fs, join(homeDir, '.noetic', 'rules'))) {
    push(p, 'user', 'rule');
  }

  return candidates;
}

//#endregion

//#region Import resolution

interface ResolveImportsParams {
  text: string;
  fs: FsAdapter;
  importerDir: string;
  homeDir: string;
  maxImportDepth: number;
  maxBytesPerFile: number;
  maxLinesPerFile: number;
  visited: Set<string>;
  depth: number;
  collected: string[];
}

async function resolveImports(params: ResolveImportsParams): Promise<string> {
  const { text, fs, importerDir, homeDir, maxImportDepth, visited, depth, collected } = params;

  if (depth >= maxImportDepth) {
    return text.replace(IMPORT_LINE_PATTERN, (_match, p1: string) => {
      return `[@${p1} skipped: import depth limit ${maxImportDepth} reached]`;
    });
  }

  const matches: Array<{
    full: string;
    raw: string;
    absolute: string;
  }> = [];
  IMPORT_LINE_PATTERN.lastIndex = 0;
  for (
    let match = IMPORT_LINE_PATTERN.exec(text);
    match !== null;
    match = IMPORT_LINE_PATTERN.exec(text)
  ) {
    const raw = match[1];
    if (raw === undefined) {
      continue;
    }
    const absolute = resolveImportPath(raw, importerDir, homeDir);
    matches.push({
      full: match[0],
      raw,
      absolute,
    });
  }

  if (matches.length === 0) {
    return text;
  }

  let result = text;
  for (const m of matches) {
    if (visited.has(m.absolute)) {
      result = result.split(m.full).join(`[import cycle: @${m.raw}]`);
      continue;
    }

    const body = await readIfExists(fs, m.absolute);
    if (body === null) {
      result = result.split(m.full).join(`[@${m.raw} not found]`);
      continue;
    }

    collected.push(m.absolute);
    const nextVisited = new Set(visited);
    nextVisited.add(m.absolute);
    const truncated = truncateText(body, params.maxLinesPerFile, params.maxBytesPerFile);
    const resolved = await resolveImports({
      ...params,
      text: truncated.content,
      importerDir: dirname(m.absolute),
      visited: nextVisited,
      depth: depth + 1,
    });
    result = result.split(m.full).join(resolved);
  }

  return result;
}

function resolveImportPath(raw: string, importerDir: string, homeDir: string): string {
  if (raw.startsWith('~/')) {
    return resolve(homeDir, raw.slice(2));
  }
  if (isAbsolute(raw)) {
    return resolve(raw);
  }
  return resolve(importerDir, raw);
}

//#endregion

//#region Truncation

interface TruncateResult {
  content: string;
  truncated: boolean;
}

function truncateText(body: string, maxLines: number, maxBytes: number): TruncateResult {
  let content = body;
  let truncated = false;
  const lines = content.split('\n');
  if (lines.length > maxLines) {
    content = `${lines.slice(0, maxLines).join('\n')}\n[AGENT.md truncated at ${maxLines} lines — content beyond was ignored]`;
    truncated = true;
  }
  if (Buffer.byteLength(content, 'utf-8') > maxBytes) {
    const buf = Buffer.from(content, 'utf-8');
    const truncatedBuf = buf.subarray(0, maxBytes);
    content = `${truncatedBuf.toString('utf-8')}\n[AGENT.md truncated at ${maxBytes} bytes — content beyond was ignored]`;
    truncated = true;
  }
  return {
    content,
    truncated,
  };
}

//#endregion

//#region Rendering

function headerFor(source: AgentInstructionSource): string {
  return `Contents of ${source.displayPath} (${source.roleDescription}):`;
}

function renderAll(sources: ReadonlyArray<AgentInstructionSource>): string {
  return sources.map((s) => `${headerFor(s)}\n\n${s.content}`).join('\n\n');
}

//#endregion

//#region Processing pipeline per candidate

interface ProcessCandidateOpts {
  fs: FsAdapter;
  shell: ShellAdapter;
  cwd: string;
  homeDir: string;
  maxLinesPerFile: number;
  maxBytesPerFile: number;
  maxImportDepth: number;
  trustProjectEmbeddedCommands: boolean;
}

async function processCandidate(
  candidate: CandidatePath,
  opts: ProcessCandidateOpts,
): Promise<AgentInstructionSource | null> {
  const raw = await readIfExists(opts.fs, candidate.path);
  if (raw === null) {
    return null;
  }

  const resolvedImports: string[] = [];
  const visited = new Set<string>([
    candidate.path,
  ]);
  const afterImports = await resolveImports({
    text: raw,
    fs: opts.fs,
    importerDir: dirname(candidate.path),
    homeDir: opts.homeDir,
    maxImportDepth: opts.maxImportDepth,
    maxBytesPerFile: opts.maxBytesPerFile,
    maxLinesPerFile: opts.maxLinesPerFile,
    visited,
    depth: 0,
    collected: resolvedImports,
  });

  const canRunCommands = candidate.origin === 'user' || opts.trustProjectEmbeddedCommands === true;
  const afterCommands = canRunCommands
    ? await processSkillContent(afterImports, opts.cwd, opts.shell)
    : neutralizeEmbeddedCommands(afterImports);

  const { content, truncated } = truncateText(
    afterCommands,
    opts.maxLinesPerFile,
    opts.maxBytesPerFile,
  );

  const displayPath = toDisplayPath(candidate.path, opts.homeDir);
  const roleDescription = candidate.origin === 'project' ? PROJECT_ROLE : USER_ROLE;

  return {
    path: candidate.path,
    displayPath,
    origin: candidate.origin,
    kind: candidate.kind,
    roleDescription,
    content,
    wasTruncated: truncated,
    byteSize: Buffer.byteLength(content, 'utf-8'),
    resolvedImports,
  };
}

/**
 * When embedded-command execution is disabled for project files, leave the
 * `!cmd` lines intact so the model can see the author's intent, but tag them
 * with a comment explaining why they did not run.
 */
function neutralizeEmbeddedCommands(text: string): string {
  return text.replace(/^(\s*)!(.+)$/gm, (_match, indent: string, rest: string) => {
    return `${indent}!${rest}\n${indent}<!-- project embedded command not executed; enable via config.trustProjectEmbeddedCommands -->`;
  });
}

//#endregion

//#region Total-cap enforcement

interface EnforceCapResult {
  kept: AgentInstructionSource[];
  totalCapExceeded: boolean;
}

/**
 * Drop lowest-precedence sources until total bytes is under cap. Precedence is
 * the original discovery order (earlier = higher precedence); we drop from the
 * tail forward.
 */
function enforceTotalCap(
  sources: AgentInstructionSource[],
  maxTotalBytes: number,
): EnforceCapResult {
  const kept = [
    ...sources,
  ];
  let total = kept.reduce((sum, s) => sum + s.byteSize, 0);
  let exceeded = false;
  while (total > maxTotalBytes && kept.length > 0) {
    const dropped = kept.pop();
    if (dropped === undefined) {
      break;
    }
    total -= dropped.byteSize;
    exceeded = true;
  }
  return {
    kept,
    totalCapExceeded: exceeded,
  };
}

//#endregion

//#region Public API

export async function loadAgentInstructions(
  opts: LoadAgentInstructionsOpts,
): Promise<AgentInstructionResult> {
  const homeDir = opts.homeDir ?? homedir();
  const shell = opts.shell ?? createLocalShellAdapter();
  const maxLinesPerFile = opts.maxLinesPerFile ?? DEFAULT_MAX_LINES_PER_FILE;
  const maxBytesPerFile = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxImportDepth = opts.maxImportDepth ?? DEFAULT_MAX_IMPORT_DEPTH;
  const trustProjectEmbeddedCommands = opts.trustProjectEmbeddedCommands ?? false;

  const candidates = await collectCandidates(opts.fs, opts.cwd, homeDir);

  const processed: AgentInstructionSource[] = [];
  for (const candidate of candidates) {
    const src = await processCandidate(candidate, {
      fs: opts.fs,
      shell,
      cwd: opts.cwd,
      homeDir,
      maxLinesPerFile,
      maxBytesPerFile,
      maxImportDepth,
      trustProjectEmbeddedCommands,
    });
    if (src === null) {
      continue;
    }
    processed.push(src);
  }

  const { kept, totalCapExceeded } = enforceTotalCap(processed, maxTotalBytes);
  const text = renderAll(kept);
  const totalBytes = kept.reduce((sum, s) => sum + s.byteSize, 0);

  return {
    text,
    sources: kept,
    totalBytes,
    totalCapExceeded,
  };
}

//#endregion
