import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';

//#region Types

/** Verdict for one file the optimizer wants to rewrite. */
export interface FileGuardVerdict {
  filePath: string;
  status: 'clean' | 'dirty' | 'untracked' | 'no-repo';
}

export class WriteGuardError extends Error {
  readonly verdicts: FileGuardVerdict[];

  constructor(verdicts: FileGuardVerdict[]) {
    const blocked = verdicts.filter((v) => v.status !== 'clean');
    super(
      `Refusing to write optimized values into ${blocked.length} file(s) that are not committed-and-clean in git:\n` +
        blocked.map((v) => `  ${v.filePath} (${v.status})`).join('\n') +
        '\nOptimization write-back REPLACES your prompt literals; if the new value scores higher by gaming the metric, ' +
        'a clean git state is the only way back. Commit or stash first, or pass forceDirty (CLI: --force-dirty) to override.',
    );
    this.name = 'WriteGuardError';
    this.verdicts = verdicts;
  }
}

//#endregion

//#region Guard

function gitStatusFor(filePath: string): FileGuardVerdict['status'] {
  const absolutePath = realpathSync(filePath);
  const rootResult = spawnSync(
    'git',
    [
      'rev-parse',
      '--show-toplevel',
    ],
    {
      cwd: path.dirname(absolutePath),
      encoding: 'utf-8',
    },
  );
  if (rootResult.status !== 0) {
    return 'no-repo';
  }
  const root = realpathSync(rootResult.stdout.trim());
  const relativePath = path.relative(root, absolutePath);
  const tracked = spawnSync(
    'git',
    [
      'ls-files',
      '--error-unmatch',
      '--',
      relativePath,
    ],
    {
      cwd: root,
      encoding: 'utf-8',
    },
  );
  if (tracked.status !== 0) {
    return 'untracked';
  }
  const status = spawnSync(
    'git',
    [
      'status',
      '--porcelain',
      '--',
      relativePath,
    ],
    {
      cwd: root,
      encoding: 'utf-8',
    },
  );
  return status.stdout.trim() === '' ? 'clean' : 'dirty';
}

/**
 * Version-control guard for optimizer write-back. Every target file must be
 * git-tracked with no uncommitted modifications, so a bad optimization result
 * (metric gaming is GEPA's classic failure mode) is always one `git checkout`
 * from recovery. Throws {@link WriteGuardError} listing every blocked file;
 * `forceDirty` skips the check entirely (deliberate, logged by the caller).
 */
export function assertWritableUnderVersionControl(
  filePaths: ReadonlyArray<string>,
  forceDirty?: boolean,
): FileGuardVerdict[] {
  const unique = [
    ...new Set(filePaths),
  ];
  const verdicts = unique.map((filePath) => ({
    filePath,
    status: gitStatusFor(filePath),
  }));
  if (forceDirty && verdicts.every((v) => v.status !== 'no-repo')) {
    return verdicts;
  }
  if (verdicts.some((v) => v.status !== 'clean')) {
    throw new WriteGuardError(verdicts);
  }
  return verdicts;
}

//#endregion
