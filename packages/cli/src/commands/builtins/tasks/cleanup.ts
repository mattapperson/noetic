import { resolve } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { exec } from '../diff-review/exec.js';
import type { TasksDatabase } from './db/index.js';
import { openTasksDatabase } from './db/index.js';
import type { TaskRecord } from './db/schema.js';
import { tasks } from './db/schema.js';

export interface CommandRunnerArgs {
  command: string;
  args: ReadonlyArray<string>;
  cwd: string;
  timeoutMs?: number;
}

export type CommandRunner = (args: CommandRunnerArgs) => Promise<CommandResult>;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CleanupMergedWorktreesResult {
  removed: number;
  blocked: number;
}

const DEFAULT_BRANCH_CANDIDATES = [
  'main',
  'master',
];
const COMMAND_TIMEOUT_MS = 30_000;
const PROVIDER_TIMEOUT_MS = 15_000;

const ProviderJsonSchema = z.record(z.string(), z.unknown());

export async function cleanupMergedWorktreesForKnownProjects(args: {
  cwd: string;
  openDatabase?: (cwd: string) => TasksDatabase;
  run?: CommandRunner;
}): Promise<CleanupMergedWorktreesResult> {
  const openDatabase = args.openDatabase ?? openTasksDatabase;
  const opened = openDatabase(args.cwd);
  try {
    const rows = opened.db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, cleanupCandidateStatuses()))
      .all()
      .filter((task) => resolve(task.projectRoot) !== resolve(task.worktreePath));
    return await cleanupTaskRows({
      opened,
      rows,
      run: args.run,
    });
  } finally {
    opened.close();
  }
}

export async function cleanupMergedWorktreesForProject(args: {
  cwd: string;
  projectRoot: string;
  openDatabase?: (cwd: string) => TasksDatabase;
  run?: CommandRunner;
}): Promise<CleanupMergedWorktreesResult> {
  const openDatabase = args.openDatabase ?? openTasksDatabase;
  const opened = openDatabase(args.cwd);
  try {
    const rows = opened.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.projectRoot, resolve(args.projectRoot)),
          inArray(tasks.status, cleanupCandidateStatuses()),
        ),
      )
      .all()
      .filter((task) => resolve(task.projectRoot) !== resolve(task.worktreePath));
    return await cleanupTaskRows({
      opened,
      rows,
      run: args.run,
    });
  } finally {
    opened.close();
  }
}

async function cleanupTaskRows(args: {
  opened: TasksDatabase;
  rows: TaskRecord[];
  run?: CommandRunner;
}): Promise<CleanupMergedWorktreesResult> {
  const run = args.run ?? runCommand;
  let removed = 0;
  let blocked = 0;

  for (const row of args.rows) {
    const result = await tryCleanupTask(row, run);
    if (result.kind === 'removed') {
      markTaskStatus({
        opened: args.opened,
        id: row.id,
        status: 'merged',
        reason: result.reason,
        provider: result.provider,
      });
      removed += 1;
      continue;
    }
    if (result.kind === 'blocked') {
      markTaskStatus({
        opened: args.opened,
        id: row.id,
        status: 'cleanup-blocked',
        reason: result.reason,
        provider: result.provider,
      });
      blocked += 1;
    }
  }

  return {
    removed,
    blocked,
  };
}

type CleanupAttempt =
  | {
      kind: 'removed';
      reason: string;
      provider?: ProviderIdentity;
    }
  | {
      kind: 'blocked';
      reason: string;
      provider?: ProviderIdentity;
    };

interface ProviderIdentity {
  provider: 'github' | 'gitlab';
  providerId: string | null;
  providerUrl: string | null;
}

async function tryCleanupTask(row: TaskRecord, run: CommandRunner): Promise<CleanupAttempt> {
  try {
    return await tryCleanupTaskInner(row, run);
  } catch (err) {
    return {
      kind: 'blocked',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function tryCleanupTaskInner(row: TaskRecord, run: CommandRunner): Promise<CleanupAttempt> {
  const branch = await cleanupBranch(row, run);
  const dirty = await isWorktreeDirty(row.worktreePath, run);
  if (dirty !== false) {
    return blocked(
      dirty === true ? 'worktree has uncommitted changes' : 'could not determine worktree status',
    );
  }

  const baseBranch = await findDefaultBranch(row.projectRoot, run);
  if (baseBranch === null) {
    return blocked('could not determine default branch');
  }

  if (
    await isBranchMergedLocally({
      projectRoot: row.projectRoot,
      branch,
      defaultBranch: baseBranch,
      run,
    })
  ) {
    const removed = await removeWorktreeAndBranch({
      row,
      branch,
      run,
    });
    return removed ?? removedResult(`branch ${branch} is merged into ${baseBranch}`);
  }

  if (!(await hasUpstream(row.worktreePath, run))) {
    return blocked(`branch ${branch} is not locally merged into ${baseBranch}`);
  }

  const provider = await mergedProviderIdentity(row.worktreePath, branch, run);
  if (provider === null) {
    return blocked('provider merge state could not be proven');
  }

  const removed = await removeWorktreeAndBranch({
    row,
    branch,
    run,
    forceDeleteBranch: true,
  });
  return (
    removed ??
    removedResult(
      `${provider.provider} review ${provider.providerId ?? branch} is merged`,
      provider,
    )
  );
}

async function cleanupBranch(row: TaskRecord, run: CommandRunner): Promise<string> {
  const branch = row.branch;
  if (branch === null || branch === 'detached') {
    throw new Error('branch is not known');
  }
  if (!(await branchExists(row.projectRoot, branch, run))) {
    throw new Error(`local branch ${branch} does not exist`);
  }
  return branch;
}

function blocked(reason: string, provider?: ProviderIdentity): CleanupAttempt {
  return {
    kind: 'blocked',
    reason,
    provider,
  };
}

function removedResult(reason: string, provider?: ProviderIdentity): CleanupAttempt {
  return {
    kind: 'removed',
    reason,
    provider,
  };
}

async function findDefaultBranch(projectRoot: string, run: CommandRunner): Promise<string | null> {
  const symbolic = await run({
    command: 'git',
    args: [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      '--short',
    ],
    cwd: projectRoot,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (symbolic.code === 0) {
    const branch = symbolic.stdout.trim().replace(/^origin\//, '');
    if (branch.length > 0 && branch !== 'HEAD') {
      return branch;
    }
  }
  const configured = await run({
    command: 'git',
    args: [
      'config',
      '--get',
      'init.defaultBranch',
    ],
    cwd: projectRoot,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (configured.code === 0 && configured.stdout.trim().length > 0) {
    return configured.stdout.trim();
  }
  for (const branch of DEFAULT_BRANCH_CANDIDATES) {
    const exists = await branchExists(projectRoot, branch, run);
    if (exists) {
      return branch;
    }
  }
  return null;
}

async function isWorktreeDirty(
  worktreePath: string,
  run: CommandRunner,
): Promise<boolean | 'unknown'> {
  const result = await run({
    command: 'git',
    args: [
      'status',
      '--porcelain',
    ],
    cwd: worktreePath,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    return 'unknown';
  }
  return result.stdout.trim().length > 0;
}

async function branchExists(
  projectRoot: string,
  branch: string,
  run: CommandRunner,
): Promise<boolean> {
  const result = await run({
    command: 'git',
    args: [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ],
    cwd: projectRoot,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  return result.code === 0;
}

async function isBranchMergedLocally(args: {
  projectRoot: string;
  branch: string;
  defaultBranch: string;
  run: CommandRunner;
}): Promise<boolean> {
  const result = await args.run({
    command: 'git',
    args: [
      'merge-base',
      '--is-ancestor',
      args.branch,
      args.defaultBranch,
    ],
    cwd: args.projectRoot,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  return result.code === 0;
}

async function hasUpstream(worktreePath: string, run: CommandRunner): Promise<boolean> {
  const result = await run({
    command: 'git',
    args: [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{u}',
    ],
    cwd: worktreePath,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  return result.code === 0 && result.stdout.trim().length > 0;
}

async function mergedProviderIdentity(
  worktreePath: string,
  branch: string,
  run: CommandRunner,
): Promise<ProviderIdentity | null> {
  const gh = await providerFromGh(worktreePath, branch, run);
  if (gh !== null) {
    return gh;
  }
  return providerFromGlab(worktreePath, branch, run);
}

async function providerFromGh(
  worktreePath: string,
  branch: string,
  run: CommandRunner,
): Promise<ProviderIdentity | null> {
  const auth = await run({
    command: 'gh',
    args: [
      'auth',
      'status',
    ],
    cwd: worktreePath,
    timeoutMs: PROVIDER_TIMEOUT_MS,
  });
  if (auth.code !== 0) {
    return null;
  }
  const result = await run({
    command: 'gh',
    args: [
      'pr',
      'view',
      branch,
      '--json',
      'number,url,mergedAt,state',
    ],
    cwd: worktreePath,
    timeoutMs: PROVIDER_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    return null;
  }
  const parsed = parseProviderJson(result.stdout);
  if (parsed === null || !isMergedProviderState(parsed)) {
    return null;
  }
  return {
    provider: 'github',
    providerId: parsed.number === undefined ? null : String(parsed.number),
    providerUrl: typeof parsed.url === 'string' ? parsed.url : null,
  };
}

async function providerFromGlab(
  worktreePath: string,
  branch: string,
  run: CommandRunner,
): Promise<ProviderIdentity | null> {
  const auth = await run({
    command: 'glab',
    args: [
      'auth',
      'status',
    ],
    cwd: worktreePath,
    timeoutMs: PROVIDER_TIMEOUT_MS,
  });
  if (auth.code !== 0) {
    return null;
  }
  const result = await run({
    command: 'glab',
    args: [
      'mr',
      'view',
      branch,
      '--output',
      'json',
    ],
    cwd: worktreePath,
    timeoutMs: PROVIDER_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    return null;
  }
  const parsed = parseProviderJson(result.stdout);
  if (parsed === null || !isMergedProviderState(parsed)) {
    return null;
  }
  return {
    provider: 'gitlab',
    providerId:
      parsed.iid === undefined
        ? parsed.id === undefined
          ? null
          : String(parsed.id)
        : String(parsed.iid),
    providerUrl:
      typeof parsed.web_url === 'string'
        ? parsed.web_url
        : typeof parsed.url === 'string'
          ? parsed.url
          : null,
  };
}

function parseProviderJson(output: string): Record<string, unknown> | null {
  try {
    return ProviderJsonSchema.parse(JSON.parse(output));
  } catch {
    return null;
  }
}

function isMergedProviderState(parsed: Record<string, unknown>): boolean {
  const state = typeof parsed.state === 'string' ? parsed.state.toLowerCase() : '';
  const mergedAt = typeof parsed.mergedAt === 'string' ? parsed.mergedAt : '';
  const mergedAtSnake = typeof parsed.merged_at === 'string' ? parsed.merged_at : '';
  return state === 'merged' || mergedAt.length > 0 || mergedAtSnake.length > 0;
}

async function removeWorktreeAndBranch(args: {
  row: TaskRecord;
  branch: string;
  run: CommandRunner;
  forceDeleteBranch?: boolean;
}): Promise<CleanupAttempt | null> {
  const remove = await args.run({
    command: 'git',
    args: [
      'worktree',
      'remove',
      args.row.worktreePath,
    ],
    cwd: args.row.projectRoot,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (remove.code !== 0) {
    return {
      kind: 'blocked',
      reason: `git worktree remove failed: ${commandDetail(remove)}`,
    };
  }
  const deleteBranch = await args.run({
    command: 'git',
    args: [
      'branch',
      args.forceDeleteBranch === true ? '-D' : '-d',
      args.branch,
    ],
    cwd: args.row.projectRoot,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (deleteBranch.code !== 0) {
    return {
      kind: 'blocked',
      reason: `git branch ${args.forceDeleteBranch === true ? '-D' : '-d'} failed after worktree removal: ${commandDetail(deleteBranch)}`,
    };
  }
  return null;
}

function markTaskStatus(args: {
  opened: TasksDatabase;
  id: string;
  status: TaskRecord['status'];
  reason: string;
  provider?: ProviderIdentity;
}): void {
  const now = new Date().toISOString();
  args.opened.db
    .update(tasks)
    .set({
      status: args.status,
      cleanupReason: args.reason,
      cleanupAt: now,
      provider: args.provider?.provider ?? null,
      providerId: args.provider?.providerId ?? null,
      providerUrl: args.provider?.providerUrl ?? null,
      updatedAt: now,
    })
    .where(eq(tasks.id, args.id))
    .run();
}

async function runCommand(args: CommandRunnerArgs): Promise<CommandResult> {
  return withTimeout(
    exec(args.command, args.args, {
      cwd: args.cwd,
    }),
    args.timeoutMs ?? COMMAND_TIMEOUT_MS,
    args.command,
  );
}

function cleanupCandidateStatuses(): Array<TaskRecord['status']> {
  return [
    'active',
    'cleanup-blocked',
  ];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, command: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      promise,
      timeout,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function commandDetail(result: CommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
}
