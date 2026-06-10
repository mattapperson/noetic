/**
 * AGENT.md + rules loader.
 *
 * Discovers user-global and project-local instruction files, resolves
 * `@path.md` imports (cycle-safe, depth-limited, symlink-canonicalised via
 * `node:fs/promises.realpath`), executes embedded `!command` lines via
 * `processSkillContent`, truncates each file to a per-file cap with a
 * single-pass emitter, and renders a combined body with
 * `Contents of <path> (<desc>):` headers matching Claude Code's rendering.
 *
 * Symlink note: cycle detection canonicalises paths with the real filesystem.
 * Virtual `FsAdapter` implementations do not participate in symlink
 * resolution — tests that exercise symlinks must use the real FS.
 */

import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { MutationPolicy } from '@noetic-tools/code-agent/tools/node';
import type { FsAdapter, ShellAdapter } from '@noetic-tools/core';
import { createLocalShellAdapter } from '@noetic-tools/platform-node';
import { neutralizeEmbeddedCommands, processSkillContent } from '../util/skill-processor.js';

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
  /**
   * Mutation policy consulted by the shared shell preflight for embedded
   * `!command` lines. Command validation (banned/high-risk/interactive)
   * always runs regardless.
   */
  mutationPolicy?: MutationPolicy;
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

/**
 * Regex matching both opening and closing forms of the reserved
 * `<system-reminder>` tag, case-insensitive. Loader-escaped so attacker-
 * controlled AGENT.md content cannot forge runtime reminders.
 */
const SYSTEM_REMINDER_TAG_PATTERN = /<(\/?system-reminder)>/gi;

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

/**
 * Canonicalise a path by resolving symlinks. Two imports that refer to the
 * same inode via a symlink and its target must collapse to the same key so
 * the visited-set cycle guard catches them. Falls back to the input when the
 * path does not exist (the caller decides what to do with missing files).
 */
async function canonicalize(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
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
  // 4. Ancestor walk from cwd up to repo root (exclusive of cwd which is
  //    already covered). Dual-bounded: stops at `dirname(repoRoot)` AND at
  //    `homeDir`. When cwd is outside a git repo (`repoRoot === null`) the
  //    ancestor walk is skipped entirely — this prevents a `/tmp/AGENT.md`
  //    or `/AGENT.md` from ever being loaded on a shared host.
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

//#region Loader context (shared across imports/candidate pipelines)

interface LoaderCtx {
  fs: FsAdapter;
  shell: ShellAdapter;
  cwd: string;
  homeDir: string;
  maxLinesPerFile: number;
  maxBytesPerFile: number;
  maxImportDepth: number;
  trustProjectEmbeddedCommands: boolean;
  mutationPolicy?: MutationPolicy;
}

//#endregion

//#region Import resolution

/**
 * Wrap a transcluded body in HTML-comment delimiters so that a truncated
 * body with an unclosed code fence cannot poison the parent's markdown. The
 * comments survive CommonMark rendering without opening or closing any
 * implicit block.
 */
function fenceTranscluded(rawPath: string, body: string): string {
  return `<!-- @import: ${rawPath} begin -->\n${body}\n<!-- @import: ${rawPath} end -->`;
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

interface ResolveImportsState {
  text: string;
  importerDir: string;
  visited: Set<string>;
  depth: number;
  collected: string[];
}

async function resolveImports(ctx: LoaderCtx, st: ResolveImportsState): Promise<string> {
  if (st.depth >= ctx.maxImportDepth) {
    return st.text.replace(IMPORT_LINE_PATTERN, (_match, p1: string) => {
      return `<!-- @import: ${p1} skipped: import depth limit ${ctx.maxImportDepth} reached -->`;
    });
  }

  interface MatchHit {
    full: string;
    raw: string;
    absolute: string;
  }
  const matches: MatchHit[] = [];
  IMPORT_LINE_PATTERN.lastIndex = 0;
  for (
    let match = IMPORT_LINE_PATTERN.exec(st.text);
    match !== null;
    match = IMPORT_LINE_PATTERN.exec(st.text)
  ) {
    const raw = match[1];
    if (raw === undefined) {
      continue;
    }
    matches.push({
      full: match[0],
      raw,
      absolute: resolveImportPath(raw, st.importerDir, ctx.homeDir),
    });
  }

  if (matches.length === 0) {
    return st.text;
  }

  let result = st.text;
  for (const m of matches) {
    const canonical = await canonicalize(m.absolute);
    if (st.visited.has(canonical)) {
      result = result.split(m.full).join(`<!-- @import: ${m.raw} cycle -->`);
      continue;
    }

    const body = await readIfExists(ctx.fs, m.absolute);
    if (body === null) {
      result = result.split(m.full).join(`<!-- @import: ${m.raw} not found -->`);
      continue;
    }

    // Record the canonical path before recursing so subsequent sibling
    // imports that resolve to the same file (e.g. via a symlink alias) hit
    // the cycle-guard branch above. `visited` is shared by reference across
    // sibling iterations; descendants get their own branched copy below.
    st.visited.add(canonical);
    st.collected.push(canonical);
    const descendantVisited = new Set(st.visited);
    const truncated = truncateContent(body, ctx.maxLinesPerFile, ctx.maxBytesPerFile);
    const resolved = await resolveImports(ctx, {
      text: truncated.content,
      importerDir: dirname(m.absolute),
      visited: descendantVisited,
      depth: st.depth + 1,
      collected: st.collected,
    });
    result = result.split(m.full).join(fenceTranscluded(m.raw, resolved));
  }

  return result;
}

//#endregion

//#region Truncation

interface TruncateResult {
  content: string;
  truncated: boolean;
}

/**
 * Single-pass truncation: applies the line cap first, then the byte cap on
 * the already-line-truncated content, and emits at most one marker naming
 * whichever cap actually triggered (byte cap wins when both would trigger,
 * since the byte view is the downstream view the model actually sees).
 */
function truncateContent(body: string, maxLines: number, maxBytes: number): TruncateResult {
  let content = body;
  let cap: 'lines' | 'bytes' | null = null;

  const lines = content.split('\n');
  if (lines.length > maxLines) {
    content = lines.slice(0, maxLines).join('\n');
    cap = 'lines';
  }

  if (Buffer.byteLength(content, 'utf-8') > maxBytes) {
    // Reserve a conservative tail for the marker so the final rendered size
    // stays within the cap.
    const markerReserve = 120;
    const sliceCap = Math.max(0, maxBytes - markerReserve);
    const buf = Buffer.from(content, 'utf-8');
    content = buf.subarray(0, sliceCap).toString('utf-8');
    cap = 'bytes';
  }

  if (cap === null) {
    return {
      content,
      truncated: false,
    };
  }

  const marker =
    cap === 'lines'
      ? `\n[AGENT.md truncated at ${maxLines} lines — content beyond was ignored]`
      : `\n[AGENT.md truncated at ${maxBytes} bytes — content beyond was ignored]`;
  return {
    content: `${content}${marker}`,
    truncated: true,
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

//#region Security helpers

/**
 * Escape literal `<system-reminder>` / `</system-reminder>` tags in loaded
 * content so attacker-controlled AGENT.md cannot forge runtime reminders
 * that the model treats as authoritative. HTML entity escape (rather than
 * deletion) preserves the author's intent for human readers.
 */
function escapeSystemReminderTags(text: string): string {
  return text.replace(SYSTEM_REMINDER_TAG_PATTERN, (_match, tag: string) => {
    return `&lt;${tag}&gt;`;
  });
}

//#endregion

//#region Processing pipeline per candidate

async function processCandidate(
  candidate: CandidatePath,
  ctx: LoaderCtx,
): Promise<AgentInstructionSource | null> {
  const raw = await readIfExists(ctx.fs, candidate.path);
  if (raw === null) {
    return null;
  }

  const resolvedImports: string[] = [];
  const visited = new Set<string>([
    await canonicalize(candidate.path),
  ]);
  const afterImports = await resolveImports(ctx, {
    text: raw,
    importerDir: dirname(candidate.path),
    visited,
    depth: 0,
    collected: resolvedImports,
  });

  const canRunCommands = candidate.origin === 'user' || ctx.trustProjectEmbeddedCommands === true;
  const afterCommands = canRunCommands
    ? await processSkillContent({
        content: afterImports,
        cwd: ctx.cwd,
        shell: ctx.shell,
        mutationPolicy: ctx.mutationPolicy,
      })
    : neutralizeEmbeddedCommands(afterImports);

  const { content: truncatedContent, truncated } = truncateContent(
    afterCommands,
    ctx.maxLinesPerFile,
    ctx.maxBytesPerFile,
  );

  const content = escapeSystemReminderTags(truncatedContent);
  const displayPath = toDisplayPath(candidate.path, ctx.homeDir);
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
  const ctx: LoaderCtx = {
    fs: opts.fs,
    shell: opts.shell ?? createLocalShellAdapter(),
    cwd: opts.cwd,
    homeDir: opts.homeDir ?? homedir(),
    maxLinesPerFile: opts.maxLinesPerFile ?? DEFAULT_MAX_LINES_PER_FILE,
    maxBytesPerFile: opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE,
    maxImportDepth: opts.maxImportDepth ?? DEFAULT_MAX_IMPORT_DEPTH,
    trustProjectEmbeddedCommands: opts.trustProjectEmbeddedCommands ?? false,
    mutationPolicy: opts.mutationPolicy,
  };
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const candidates = await collectCandidates(ctx.fs, ctx.cwd, ctx.homeDir);

  const processed: AgentInstructionSource[] = [];
  for (const candidate of candidates) {
    const src = await processCandidate(candidate, ctx);
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
