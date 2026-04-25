/**
 * Git plumbing for /diff-review.
 *
 * Ported from upstream `@ryan_nookpi/pi-extension-diff-review` `git.ts`
 * (https://github.com/Jonghakseo/pi-extension/blob/main/packages/diff-review/git.ts).
 * The only structural change is that every `pi.exec(...)` call is replaced by
 * the local `exec(...)` helper — every behaviour (merge-base resolution chain,
 * working-tree snapshot trick, status-porcelain parsing, rename handling) is
 * preserved.
 *
 * Image/binary preview URLs are intentionally always returned as `null`
 * (terminal port — no inline previews); the data shape is kept for parity
 * with upstream so the prompt composer and types do not have to fork.
 */

import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { exec } from './exec.js';
import type {
  ReviewCommitInfo,
  ReviewFile,
  ReviewFileComparison,
  ReviewWindowData,
} from './types.js';
import { ChangeStatus, ReviewCommitKind, ReviewFileKind, ReviewScope } from './types.js';

//#region Internal types

interface ChangedPath {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
}

interface ReviewBaseInfo {
  mergeBase: string;
  baseRef: string;
}

interface WorkingTreeStatusInfo {
  hasChanges: boolean;
  hasReviewableChanges: boolean;
  hasUntracked: boolean;
  hasTrackedDeletions: boolean;
  hasRenames: boolean;
  untrackedPaths: string[];
}

//#endregion

//#region Working-tree sentinel commit

const WORKING_TREE_COMMIT_SHA = '__noetic_working_tree__';
const WORKING_TREE_COMMIT_SHORT_SHA = 'WT';
const WORKING_TREE_COMMIT_SUBJECT = 'Uncommitted changes';

export function isWorkingTreeCommitSha(sha: string): boolean {
  return sha === WORKING_TREE_COMMIT_SHA;
}

function createWorkingTreeCommitInfo(): ReviewCommitInfo {
  return {
    sha: WORKING_TREE_COMMIT_SHA,
    shortSha: WORKING_TREE_COMMIT_SHORT_SHA,
    subject: WORKING_TREE_COMMIT_SUBJECT,
    authorName: '',
    authorDate: '',
    kind: ReviewCommitKind.WorkingTree,
  };
}

//#endregion

//#region Exec wrappers

async function runGitAllowFailure(repoRoot: string, args: ReadonlyArray<string>): Promise<string> {
  const result = await exec('git', args, {
    cwd: repoRoot,
  });
  if (result.code !== 0) {
    return '';
  }
  return result.stdout;
}

async function runBashAllowFailure(repoRoot: string, script: string): Promise<string> {
  const result = await exec(
    'bash',
    [
      '-c',
      script,
    ],
    {
      cwd: repoRoot,
    },
  );
  if (result.code !== 0) {
    return '';
  }
  return result.stdout;
}

//#endregion

//#region Repo metadata

export async function getRepoRoot(cwd: string): Promise<string> {
  const result = await exec(
    'git',
    [
      'rev-parse',
      '--show-toplevel',
    ],
    {
      cwd,
    },
  );
  if (result.code !== 0) {
    throw new Error('Not inside a git repository.');
  }
  return result.stdout.trim();
}

async function hasHead(repoRoot: string): Promise<boolean> {
  const result = await exec(
    'git',
    [
      'rev-parse',
      '--verify',
      'HEAD',
    ],
    {
      cwd: repoRoot,
    },
  );
  return result.code === 0;
}

async function currentBranch(repoRoot: string): Promise<string> {
  const result = await exec(
    'git',
    [
      'branch',
      '--show-current',
    ],
    {
      cwd: repoRoot,
    },
  );
  if (result.code !== 0) {
    return 'HEAD';
  }
  const trimmed = result.stdout.trim();
  return trimmed.length > 0 ? trimmed : 'HEAD';
}

async function getUpstreamRef(repoRoot: string): Promise<string | null> {
  const output = await runGitAllowFailure(repoRoot, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);
  const value = output.trim();
  return value.length > 0 ? value : null;
}

async function getOriginHeadRef(repoRoot: string): Promise<string | null> {
  const output = await runGitAllowFailure(repoRoot, [
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    '--short',
  ]);
  const value = output.trim();
  return value.length > 0 ? value : null;
}

function isSameBranchRef(ref: string, branch: string): boolean {
  if (!branch || branch === 'HEAD') {
    return false;
  }
  return ref === branch || ref.endsWith(`/${branch}`);
}

async function findReviewBase(repoRoot: string): Promise<ReviewBaseInfo | null> {
  const [branch, upstreamRef, originHeadRef] = await Promise.all([
    currentBranch(repoRoot),
    getUpstreamRef(repoRoot),
    getOriginHeadRef(repoRoot),
  ]);
  const candidates: string[] = [];

  if (upstreamRef && !isSameBranchRef(upstreamRef, branch)) {
    candidates.push(upstreamRef);
  }
  if (originHeadRef) {
    candidates.push(originHeadRef);
  }

  candidates.push('origin/main', 'origin/master', 'origin/develop', 'main', 'master', 'develop');

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const mergeBase = (
      await runGitAllowFailure(repoRoot, [
        'merge-base',
        'HEAD',
        candidate,
      ])
    ).trim();
    if (mergeBase.length > 0) {
      return {
        mergeBase,
        baseRef: candidate,
      };
    }
  }

  return null;
}

//#endregion

//#region name-status parsing

function parseNameStatusLine(parts: ReadonlyArray<string>): ChangedPath | null {
  const code = (parts[0] ?? '')[0];

  if (code === 'R') {
    const oldPath = parts[1] ?? null;
    const newPath = parts[2] ?? null;
    if (oldPath === null || newPath === null) {
      return null;
    }
    return {
      status: ChangeStatus.Renamed,
      oldPath,
      newPath,
    };
  }

  const path = parts[1] ?? null;
  if (path === null) {
    return null;
  }

  if (code === 'M') {
    return {
      status: ChangeStatus.Modified,
      oldPath: path,
      newPath: path,
    };
  }
  if (code === 'A') {
    return {
      status: ChangeStatus.Added,
      oldPath: null,
      newPath: path,
    };
  }
  if (code === 'D') {
    return {
      status: ChangeStatus.Deleted,
      oldPath: path,
      newPath: null,
    };
  }
  return null;
}

function parseNameStatus(output: string): ChangedPath[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const changes: ChangedPath[] = [];
  for (const line of lines) {
    const change = parseNameStatusLine(line.split('\t'));
    if (change !== null) {
      changes.push(change);
    }
  }
  return changes;
}

function parseStatusPorcelainZ(output: string): WorkingTreeStatusInfo {
  const info: WorkingTreeStatusInfo = {
    hasChanges: false,
    hasReviewableChanges: false,
    hasUntracked: false,
    hasTrackedDeletions: false,
    hasRenames: false,
    untrackedPaths: [],
  };
  const tokens = output.split('\0');

  for (let index = 0; index < tokens.length; ) {
    const token = tokens[index] ?? '';
    if (token.length === 0) {
      index += 1;
      continue;
    }

    const code = token.slice(0, 2);
    const path = token.slice(3);
    const isRenameOrCopy = code.includes('R') || code.includes('C');
    const isReviewablePath = code !== '!!' && path.length > 0 && isIncludedReviewPath(path);
    if (code !== '!!') {
      info.hasChanges = true;
    }
    if (isReviewablePath) {
      info.hasReviewableChanges = true;
    }
    if (code === '??') {
      if (isReviewablePath) {
        info.hasUntracked = true;
        info.untrackedPaths.push(path);
      }
    } else if (isReviewablePath) {
      if (code.includes('D')) {
        info.hasTrackedDeletions = true;
      }
      if (isRenameOrCopy) {
        info.hasRenames = true;
      }
    }

    index += isRenameOrCopy ? 2 : 1;
  }

  return info;
}

async function getWorkingTreeStatusInfo(repoRoot: string): Promise<WorkingTreeStatusInfo> {
  const output = await runGitAllowFailure(repoRoot, [
    'status',
    '--porcelain=1',
    '--untracked-files=all',
    '-z',
  ]);
  return parseStatusPorcelainZ(output);
}

//#endregion

//#region Path classification

const imageMimeTypes = new Map<string, string>([
  [
    '.avif',
    'image/avif',
  ],
  [
    '.bmp',
    'image/bmp',
  ],
  [
    '.gif',
    'image/gif',
  ],
  [
    '.ico',
    'image/x-icon',
  ],
  [
    '.jpeg',
    'image/jpeg',
  ],
  [
    '.jpg',
    'image/jpeg',
  ],
  [
    '.png',
    'image/png',
  ],
  [
    '.webp',
    'image/webp',
  ],
]);

const binaryExtensions = new Set([
  '.7z',
  '.a',
  '.avi',
  '.avif',
  '.bin',
  '.bmp',
  '.class',
  '.dll',
  '.dylib',
  '.eot',
  '.exe',
  '.gif',
  '.gz',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.lockb',
  '.map',
  '.mov',
  '.mp3',
  '.mp4',
  '.o',
  '.otf',
  '.pdf',
  '.png',
  '.pyc',
  '.so',
  '.svgz',
  '.tar',
  '.ttf',
  '.wasm',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
]);

interface FileMeta {
  kind: ReviewFileKind;
  mimeType: string | null;
}

function classifyFilePath(path: string): FileMeta {
  const extension = extname(path.toLowerCase());
  const mimeType = imageMimeTypes.get(extension) ?? null;
  if (mimeType !== null) {
    return {
      kind: ReviewFileKind.Image,
      mimeType,
    };
  }
  if (binaryExtensions.has(extension)) {
    return {
      kind: ReviewFileKind.Binary,
      mimeType: null,
    };
  }
  return {
    kind: ReviewFileKind.Text,
    mimeType: null,
  };
}

function isIncludedReviewPath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  const fileName = lowerPath.split('/').pop() ?? lowerPath;
  if (fileName.length === 0) {
    return false;
  }
  if (fileName.endsWith('.min.js') || fileName.endsWith('.min.css')) {
    return false;
  }
  return true;
}

//#endregion

//#region Comparison + ID helpers

function toDisplayPath(change: ChangedPath): string {
  if (change.status === ChangeStatus.Renamed) {
    return `${change.oldPath ?? ''} -> ${change.newPath ?? ''}`;
  }
  return change.newPath ?? change.oldPath ?? '(unknown)';
}

function toComparison(change: ChangedPath): ReviewFileComparison {
  return {
    status: change.status,
    oldPath: change.oldPath,
    newPath: change.newPath,
    displayPath: toDisplayPath(change),
    hasOriginal: change.oldPath !== null,
    hasModified: change.newPath !== null,
  };
}

function buildBranchFileId(
  path: string,
  hasWorkingTreeFile: boolean,
  gitDiff: ReviewFileComparison,
): string {
  return [
    'branch',
    path,
    hasWorkingTreeFile ? 'working' : 'gone',
    gitDiff.displayPath,
  ].join('::');
}

function buildCommitFileId(sha: string, comparison: ReviewFileComparison): string {
  return [
    'commit',
    sha,
    comparison.displayPath,
  ].join('::');
}

interface ToReviewFileOptions {
  id: string;
  worktreeStatus: ChangeStatus | null;
  hasWorkingTreeFile: boolean;
}

function toReviewFile(change: ChangedPath, options: ToReviewFileOptions): ReviewFile {
  const comparison = toComparison(change);
  const path = change.newPath ?? change.oldPath ?? comparison.displayPath;
  const meta = classifyFilePath(path);
  return {
    id: options.id,
    path,
    worktreeStatus: options.worktreeStatus,
    hasWorkingTreeFile: options.hasWorkingTreeFile,
    inGitDiff: true,
    gitDiff: comparison,
    kind: meta.kind,
    mimeType: meta.mimeType,
  };
}

function toBranchReviewFile(change: ChangedPath): ReviewFile {
  const comparison = toComparison(change);
  const path = change.newPath ?? change.oldPath ?? comparison.displayPath;
  return toReviewFile(change, {
    id: buildBranchFileId(path, change.newPath !== null, comparison),
    worktreeStatus: change.status,
    hasWorkingTreeFile: change.newPath !== null,
  });
}

//#endregion

//#region Content readers

async function getRevisionContent(
  repoRoot: string,
  revision: string,
  path: string,
): Promise<string> {
  const result = await exec(
    'git',
    [
      'show',
      `${revision}:${path}`,
    ],
    {
      cwd: repoRoot,
    },
  );
  if (result.code !== 0) {
    return '';
  }
  return result.stdout;
}

async function getWorkingTreeContent(repoRoot: string, path: string): Promise<string> {
  try {
    return await readFile(join(repoRoot, path), 'utf8');
  } catch {
    return '';
  }
}

//#endregion

//#region Branch + working-tree change collection

function mergeChangedPaths(...groups: ReadonlyArray<ChangedPath[]>): ChangedPath[] {
  const merged = new Map<string, ChangedPath>();
  for (const group of groups) {
    for (const change of group) {
      const key = change.newPath ?? change.oldPath ?? '';
      if (key.length === 0) {
        continue;
      }
      merged.set(key, change);
    }
  }
  return [
    ...merged.values(),
  ];
}

function toUntrackedChangedPaths(paths: ReadonlyArray<string>): ChangedPath[] {
  return paths.map((path) => ({
    status: ChangeStatus.Added,
    oldPath: null,
    newPath: path,
  }));
}

function shouldNormalizeBranchChanges(
  trackedChanges: ReadonlyArray<ChangedPath>,
  workingTreeStatus: WorkingTreeStatusInfo,
): boolean {
  if (workingTreeStatus.hasRenames) {
    return true;
  }
  if (!workingTreeStatus.hasUntracked) {
    return false;
  }
  return trackedChanges.some((change) => change.status === ChangeStatus.Deleted);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function getTrackedBranchReviewChanges(
  repoRoot: string,
  branchComparisonBase: string,
): Promise<ChangedPath[]> {
  return parseNameStatus(
    await runGitAllowFailure(repoRoot, [
      'diff',
      '--find-renames',
      '-M',
      '--name-status',
      branchComparisonBase,
      '--',
    ]),
  );
}

async function getWorkingTreeSnapshotChanges(
  repoRoot: string,
  baseRevision: string | null,
): Promise<ChangedPath[]> {
  const scriptLines = [
    'set -euo pipefail',
    'tmp_index=$(mktemp "/tmp/noetic-diff-review-index.XXXXXX")',
    `trap 'rm -f "$tmp_index"' EXIT`,
    'export GIT_INDEX_FILE="$tmp_index"',
  ];
  if (baseRevision !== null) {
    scriptLines.push(`git read-tree ${shellQuote(baseRevision)}`);
  } else {
    scriptLines.push('rm -f "$tmp_index"');
  }
  scriptLines.push('git add -A -- .');
  scriptLines.push(
    baseRevision !== null
      ? `git diff --cached --find-renames -M --name-status ${shellQuote(baseRevision)} --`
      : 'git diff --cached --find-renames -M --name-status --root --',
  );
  const output = await runBashAllowFailure(repoRoot, scriptLines.join('\n'));
  return parseNameStatus(output);
}

async function getBranchReviewChanges(
  repoRoot: string,
  branchComparisonBase: string | null,
  workingTreeStatus: WorkingTreeStatusInfo,
): Promise<ChangedPath[]> {
  if (branchComparisonBase === null) {
    return [];
  }
  const trackedChanges = await getTrackedBranchReviewChanges(repoRoot, branchComparisonBase);
  if (shouldNormalizeBranchChanges(trackedChanges, workingTreeStatus)) {
    return getWorkingTreeSnapshotChanges(repoRoot, branchComparisonBase);
  }
  return mergeChangedPaths(
    trackedChanges,
    toUntrackedChangedPaths(workingTreeStatus.untrackedPaths),
  );
}

async function getWorkingTreeReviewChanges(
  repoRoot: string,
  repositoryHasHead: boolean,
): Promise<ChangedPath[]> {
  return getWorkingTreeSnapshotChanges(repoRoot, repositoryHasHead ? 'HEAD' : null);
}

//#endregion

//#region Sorting

function compareReviewFiles(a: ReviewFile, b: ReviewFile): number {
  return a.path.localeCompare(b.path);
}

//#endregion

//#region Public API: review window assembly

export async function getReviewWindowData(cwd: string): Promise<ReviewWindowData> {
  const repoRoot = await getRepoRoot(cwd);
  const repositoryHasHead = await hasHead(repoRoot);
  // findReviewBase and getWorkingTreeStatusInfo are independent — fan them out.
  const [reviewBase, workingTreeStatus] = await Promise.all([
    repositoryHasHead ? findReviewBase(repoRoot) : Promise.resolve(null),
    getWorkingTreeStatusInfo(repoRoot),
  ]);
  const branchComparisonBase = reviewBase?.mergeBase ?? (repositoryHasHead ? 'HEAD' : null);
  const branchChanges = repositoryHasHead
    ? await getBranchReviewChanges(repoRoot, branchComparisonBase, workingTreeStatus)
    : await getWorkingTreeReviewChanges(repoRoot, false);
  const files = branchChanges
    .filter((change) => isIncludedReviewPath(change.newPath ?? change.oldPath ?? ''))
    .map(toBranchReviewFile)
    .sort(compareReviewFiles);
  const commits = reviewBase
    ? await listRangeCommits(repoRoot, `${reviewBase.mergeBase}..HEAD`, 1e2)
    : [];
  const workingTreeCommit = workingTreeStatus.hasReviewableChanges
    ? [
        createWorkingTreeCommitInfo(),
      ]
    : [];
  const fallbackCommits =
    repositoryHasHead &&
    files.length === 0 &&
    commits.length === 0 &&
    !workingTreeStatus.hasReviewableChanges
      ? await listRangeCommits(repoRoot, 'HEAD', 20)
      : commits;

  return {
    repoRoot,
    files,
    commits: [
      ...workingTreeCommit,
      ...fallbackCommits,
    ],
    branchBaseRef: reviewBase?.baseRef ?? null,
    branchMergeBaseSha: branchComparisonBase,
    repositoryHasHead,
  };
}

export async function listRangeCommits(
  repoRoot: string,
  range: string,
  limit: number,
): Promise<ReviewCommitInfo[]> {
  const sep = '\x1f';
  const format = [
    '%H',
    '%h',
    '%s',
    '%an',
    '%aI',
  ].join(sep);
  const output = await runGitAllowFailure(repoRoot, [
    'log',
    `-${limit}`,
    `--format=${format}`,
    range,
  ]);
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, shortSha, subject, authorName, authorDate] = line.split(sep);
      const safeSha = sha ?? '';
      const info: ReviewCommitInfo = {
        sha: safeSha,
        shortSha: shortSha ?? safeSha.slice(0, 7),
        subject: subject ?? '',
        authorName: authorName ?? '',
        authorDate: authorDate ?? '',
        kind: ReviewCommitKind.Commit,
      };
      return info;
    })
    .filter((commit) => commit.sha.length > 0);
}

export async function getCommitFiles(repoRoot: string, sha: string): Promise<ReviewFile[]> {
  if (isWorkingTreeCommitSha(sha)) {
    const repositoryHasHead = await hasHead(repoRoot);
    const changes = (await getWorkingTreeReviewChanges(repoRoot, repositoryHasHead)).filter(
      (change) => isIncludedReviewPath(change.newPath ?? change.oldPath ?? ''),
    );
    return changes
      .map((change): ReviewFile => {
        const comparison = toComparison(change);
        return toReviewFile(change, {
          id: buildCommitFileId(sha, comparison),
          worktreeStatus: change.status,
          hasWorkingTreeFile: change.newPath !== null,
        });
      })
      .sort(compareReviewFiles);
  }

  const output = await runGitAllowFailure(repoRoot, [
    'diff-tree',
    '--root',
    '--find-renames',
    '-M',
    '--name-status',
    '--no-commit-id',
    '-r',
    sha,
  ]);
  const changes = parseNameStatus(output).filter((change) =>
    isIncludedReviewPath(change.newPath ?? change.oldPath ?? ''),
  );
  return changes
    .map((change): ReviewFile => {
      const comparison = toComparison(change);
      return toReviewFile(change, {
        id: buildCommitFileId(sha, comparison),
        worktreeStatus: null,
        hasWorkingTreeFile: false,
      });
    })
    .sort(compareReviewFiles);
}

//#endregion

//#region Public API: file contents

interface EmptyContents {
  originalContent: string;
  modifiedContent: string;
  kind: ReviewFileKind;
  mimeType: string | null;
  originalExists: boolean;
  modifiedExists: boolean;
  originalPreviewUrl: string | null;
  modifiedPreviewUrl: string | null;
}

function emptyContents(file: ReviewFile): EmptyContents {
  return {
    originalContent: '',
    modifiedContent: '',
    kind: file.kind,
    mimeType: file.mimeType,
    originalExists: false,
    modifiedExists: false,
    originalPreviewUrl: null,
    modifiedPreviewUrl: null,
  };
}

async function loadAllScopeContents(repoRoot: string, file: ReviewFile): Promise<EmptyContents> {
  const path = file.gitDiff?.newPath ?? (file.hasWorkingTreeFile ? file.path : null);
  if (path === null) {
    return emptyContents(file);
  }
  const content = file.hasWorkingTreeFile
    ? await getWorkingTreeContent(repoRoot, path)
    : await getRevisionContent(repoRoot, 'HEAD', path);
  return {
    originalContent: content,
    modifiedContent: content,
    kind: file.kind,
    mimeType: file.mimeType,
    originalExists: true,
    modifiedExists: true,
    originalPreviewUrl: null,
    modifiedPreviewUrl: null,
  };
}

async function loadCommitsScopeContents(
  repoRoot: string,
  file: ReviewFile,
  commitSha: string | null,
): Promise<EmptyContents> {
  const comparison = file.gitDiff;
  if (comparison === null || !commitSha) {
    return emptyContents(file);
  }
  if (isWorkingTreeCommitSha(commitSha)) {
    return loadWorkingTreeCommitContents(repoRoot, file, comparison);
  }
  // commit^ vs commit — both reads are independent, fan them out.
  // For a root commit (no parent), `git show <sha>^:path` exits non-zero and
  // returns ''. Safe here because `getCommitFiles` calls `git diff-tree --root`
  // for root commits, which reports every file as Added (oldPath === null) —
  // so the originalContent branch short-circuits via the `=== null` guard
  // before any failing git call.
  const [originalContent, modifiedContent] = await Promise.all([
    comparison.oldPath === null
      ? Promise.resolve('')
      : getRevisionContent(repoRoot, `${commitSha}^`, comparison.oldPath),
    comparison.newPath === null
      ? Promise.resolve('')
      : getRevisionContent(repoRoot, commitSha, comparison.newPath),
  ]);
  return {
    originalContent,
    modifiedContent,
    kind: file.kind,
    mimeType: file.mimeType,
    originalExists: comparison.oldPath !== null,
    modifiedExists: comparison.newPath !== null,
    originalPreviewUrl: null,
    modifiedPreviewUrl: null,
  };
}

async function loadWorkingTreeCommitContents(
  repoRoot: string,
  file: ReviewFile,
  comparison: ReviewFileComparison,
): Promise<EmptyContents> {
  const repositoryHasHead = await hasHead(repoRoot);
  const [originalContent, modifiedContent] = await Promise.all([
    repositoryHasHead && comparison.oldPath !== null
      ? getRevisionContent(repoRoot, 'HEAD', comparison.oldPath)
      : Promise.resolve(''),
    comparison.newPath !== null && file.hasWorkingTreeFile
      ? getWorkingTreeContent(repoRoot, comparison.newPath)
      : Promise.resolve(''),
  ]);
  return {
    originalContent,
    modifiedContent,
    kind: file.kind,
    mimeType: file.mimeType,
    originalExists: repositoryHasHead && comparison.oldPath !== null,
    modifiedExists: comparison.newPath !== null,
    originalPreviewUrl: null,
    modifiedPreviewUrl: null,
  };
}

async function loadModifiedSideForBranch(
  repoRoot: string,
  file: ReviewFile,
  newPath: string | null,
): Promise<string> {
  if (newPath === null) {
    return '';
  }
  if (file.hasWorkingTreeFile) {
    return getWorkingTreeContent(repoRoot, newPath);
  }
  return getRevisionContent(repoRoot, 'HEAD', newPath);
}

async function loadBranchScopeContents(
  repoRoot: string,
  file: ReviewFile,
  branchMergeBaseSha: string | null,
): Promise<EmptyContents> {
  const comparison = file.gitDiff;
  if (comparison === null || branchMergeBaseSha === null) {
    return emptyContents(file);
  }
  const [originalContent, modifiedContent] = await Promise.all([
    comparison.oldPath === null
      ? Promise.resolve('')
      : getRevisionContent(repoRoot, branchMergeBaseSha, comparison.oldPath),
    loadModifiedSideForBranch(repoRoot, file, comparison.newPath),
  ]);
  return {
    originalContent,
    modifiedContent,
    kind: file.kind,
    mimeType: file.mimeType,
    originalExists: comparison.oldPath !== null,
    modifiedExists: comparison.newPath !== null,
    originalPreviewUrl: null,
    modifiedPreviewUrl: null,
  };
}

export interface LoadReviewFileContentsArgs {
  repoRoot: string;
  file: ReviewFile;
  scope: ReviewScope;
  commitSha?: string | null;
  branchMergeBaseSha?: string | null;
}

export async function loadReviewFileContents(
  args: LoadReviewFileContentsArgs,
): Promise<EmptyContents> {
  const { repoRoot, file, scope, commitSha = null, branchMergeBaseSha = null } = args;
  // Binary/image files are not previewed in the terminal port — return empty
  // contents with the kind preserved so the UI can render the badge.
  if (file.kind !== ReviewFileKind.Text) {
    return emptyContents(file);
  }
  if (scope === ReviewScope.All) {
    return loadAllScopeContents(repoRoot, file);
  }
  if (scope === ReviewScope.Commits) {
    return loadCommitsScopeContents(repoRoot, file, commitSha);
  }
  return loadBranchScopeContents(repoRoot, file, branchMergeBaseSha);
}

//#endregion

//#region Test exports

export const __testing = {
  parseStatusPorcelainZ,
  shouldNormalizeBranchChanges,
  parseNameStatus,
  classifyFilePath,
  isIncludedReviewPath,
};

//#endregion
