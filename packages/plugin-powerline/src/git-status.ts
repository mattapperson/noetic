/**
 * Async git status with a 1-second TTL cache so segment rendering on every
 * React render doesn't fork a subprocess per frame.
 */

import { spawn } from 'node:child_process';

export interface GitStatus {
  branch: string;
  staged: number;
  unstaged: number;
  untracked: number;
}

interface CacheEntry {
  at: number;
  value: GitStatus | null;
}

const TTL_MS = 1e3;
const cache = new Map<string, CacheEntry>();

export function invalidateGitCache(cwd?: string): void {
  if (typeof cwd === 'string') {
    cache.delete(cwd);
    return;
  }
  cache.clear();
}

export async function getGitStatus(cwd: string): Promise<GitStatus | null> {
  const hit = cache.get(cwd);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) {
    return hit.value;
  }
  const value = await runGitStatus(cwd);
  cache.set(cwd, {
    at: now,
    value,
  });
  return value;
}

function runGitStatus(cwd: string): Promise<GitStatus | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'git',
      [
        'status',
        '--porcelain=v2',
        '--branch',
      ],
      {
        cwd,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
        },
        stdio: [
          'ignore',
          'pipe',
          'ignore',
        ],
      },
    );
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(parseStatus(stdout));
    });
  });
}

export function parseStatus(raw: string): GitStatus | null {
  const lines = raw.split('\n');
  let branch = '';
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let sawHeader = false;
  for (const line of lines) {
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim();
      sawHeader = true;
      continue;
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const marker = line.slice(2, 4);
      const stagedChar = marker.charAt(0);
      const unstagedChar = marker.charAt(1);
      if (stagedChar !== '.') {
        staged += 1;
      }
      if (unstagedChar !== '.') {
        unstaged += 1;
      }
      continue;
    }
    if (line.startsWith('? ')) {
      untracked += 1;
    }
  }
  if (!sawHeader) {
    return null;
  }
  return {
    branch: branch || 'HEAD',
    staged,
    unstaged,
    untracked,
  };
}
