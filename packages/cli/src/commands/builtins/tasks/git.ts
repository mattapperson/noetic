import { resolve } from 'node:path';

import { exec } from '../diff-review/exec.js';

export interface ProjectWorktree {
  projectRoot: string;
  path: string;
  branch: string | null;
  headSha: string | null;
  current: boolean;
}

export type GitCommandRunner = (cwd: string, args: ReadonlyArray<string>) => Promise<string>;

export interface ParsedWorktreeRecord {
  path: string;
  headSha: string | null;
  branchRef: string | null;
  detached: boolean;
  bare: boolean;
  prunable: boolean;
}

export async function loadProjectWorktrees(cwd: string): Promise<ProjectWorktree[]> {
  return loadProjectWorktreesWithGit(cwd, gitOutput);
}

export async function loadProjectWorktreesWithGit(
  cwd: string,
  git: GitCommandRunner,
): Promise<ProjectWorktree[]> {
  const currentRoot = await getRepoRoot(cwd, git);
  const output = await git(cwd, [
    'worktree',
    'list',
    '--porcelain',
  ]);
  // The first porcelain record is always the main worktree; treat it as the project root.
  const records = parseWorktreeList(output).filter((record) => !record.bare && !record.prunable);
  const projectRoot = normalizePath(records[0]?.path ?? currentRoot);
  const normalizedCurrent = normalizePath(currentRoot);

  return records
    .filter((record) => normalizePath(record.path) !== projectRoot)
    .map((record) => {
      const path = normalizePath(record.path);
      return {
        projectRoot,
        path,
        branch: branchName(record),
        headSha: record.headSha,
        current: path === normalizedCurrent,
      };
    });
}

export function parseWorktreeList(output: string): ParsedWorktreeRecord[] {
  const records: ParsedWorktreeRecord[] = [];
  let current: ParsedWorktreeRecord | null = null;

  const flush = (): void => {
    if (current !== null) {
      records.push(current);
      current = null;
    }
  };

  for (const line of output.split('\n')) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    const [key, value] = splitPorcelainLine(line);
    if (key === 'worktree') {
      flush();
      current = {
        path: value,
        headSha: null,
        branchRef: null,
        detached: false,
        bare: false,
        prunable: false,
      };
      continue;
    }
    if (current === null) {
      continue;
    }
    switch (key) {
      case 'HEAD':
        current.headSha = value;
        break;
      case 'branch':
        current.branchRef = value;
        break;
      case 'detached':
        current.detached = true;
        break;
      case 'bare':
        current.bare = true;
        break;
      case 'prunable':
        current.prunable = true;
        break;
    }
  }
  flush();
  return records;
}

async function getRepoRoot(cwd: string, git: GitCommandRunner): Promise<string> {
  return git(cwd, [
    'rev-parse',
    '--show-toplevel',
  ]);
}

async function gitOutput(cwd: string, args: ReadonlyArray<string>): Promise<string> {
  const result = await exec('git', args, {
    cwd,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'git command failed');
  }
  return result.stdout.trim();
}

function splitPorcelainLine(line: string): [
  string,
  string,
] {
  const idx = line.indexOf(' ');
  if (idx === -1) {
    return [
      line,
      '',
    ];
  }
  return [
    line.slice(0, idx),
    line.slice(idx + 1),
  ];
}

function branchName(record: ParsedWorktreeRecord): string | null {
  if (record.branchRef === null) {
    return record.detached ? 'detached' : null;
  }
  return record.branchRef.replace(/^refs\/heads\//, '');
}

function normalizePath(path: string): string {
  return resolve(path);
}
