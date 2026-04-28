import { describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { runAgentCiCommand } from '../src/commands/builtins/agent-ci/index.js';
import type { ProjectWorktree } from '../src/commands/builtins/tasks/git.js';

interface MockHarness {
  loadProjectWorktreesFn: ReturnType<typeof mock<(cwd: string) => Promise<ProjectWorktree[]>>>;
  startAgentCiRunFn: ReturnType<
    typeof mock<
      (args: { taskId: string; workflow: string; cwd: string }) => {
        sessionId: string;
        pid: number;
        workflow: string;
      }
    >
  >;
}

function makeHarness(worktrees: ProjectWorktree[]): MockHarness {
  return {
    loadProjectWorktreesFn: mock(async (_cwd: string) => worktrees),
    startAgentCiRunFn: mock((args) => ({
      sessionId: `${args.taskId}-deadbeef`,
      pid: 4242,
      workflow: args.workflow,
    })),
  };
}

describe('runAgentCiCommand', () => {
  test('rejects empty args with usage hint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-agent-ci-cmd-'));
    const harness = makeHarness([]);
    const out = await runAgentCiCommand({
      rawArg: '   ',
      cwd: dir,
      loadProjectWorktreesFn: harness.loadProjectWorktreesFn,
      startAgentCiRunFn: harness.startAgentCiRunFn,
    });
    expect(out).toBe('Usage: /agent-ci <workflow-file>');
    expect(harness.loadProjectWorktreesFn).toHaveBeenCalledTimes(0);
  });

  test('rejects when not inside a current worktree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-agent-ci-cmd-no-current-'));
    const harness = makeHarness([
      {
        projectRoot: dir,
        path: dir,
        branch: 'main',
        headSha: null,
        current: false,
      },
    ]);
    const out = await runAgentCiCommand({
      rawArg: 'foo.yml',
      cwd: dir,
      loadProjectWorktreesFn: harness.loadProjectWorktreesFn,
      startAgentCiRunFn: harness.startAgentCiRunFn,
    });
    expect(out).toContain('not inside a tracked git worktree');
    expect(harness.startAgentCiRunFn).toHaveBeenCalledTimes(0);
  });

  test('rejects workflow path outside worktree', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'noetic-agent-ci-cmd-outside-'));
    const harness = makeHarness([
      {
        projectRoot: wt,
        path: wt,
        branch: 'feature',
        headSha: null,
        current: true,
      },
    ]);
    const out = await runAgentCiCommand({
      rawArg: '../etc/passwd',
      cwd: wt,
      loadProjectWorktreesFn: harness.loadProjectWorktreesFn,
      startAgentCiRunFn: harness.startAgentCiRunFn,
    });
    expect(out).toContain('outside the worktree');
    expect(harness.startAgentCiRunFn).toHaveBeenCalledTimes(0);
  });

  test('rejects when workflow file does not exist', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'noetic-agent-ci-cmd-missing-'));
    const harness = makeHarness([
      {
        projectRoot: wt,
        path: wt,
        branch: 'feature',
        headSha: null,
        current: true,
      },
    ]);
    const out = await runAgentCiCommand({
      rawArg: '.github/workflows/missing.yml',
      cwd: wt,
      loadProjectWorktreesFn: harness.loadProjectWorktreesFn,
      startAgentCiRunFn: harness.startAgentCiRunFn,
    });
    expect(out).toContain('workflow file not found');
    expect(harness.startAgentCiRunFn).toHaveBeenCalledTimes(0);
  });

  test('rejects when workflow path is a directory', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'noetic-agent-ci-cmd-dir-'));
    const subdir = join(wt, 'workflows');
    mkdirSync(subdir, {
      recursive: true,
    });
    const harness = makeHarness([
      {
        projectRoot: wt,
        path: wt,
        branch: 'feature',
        headSha: null,
        current: true,
      },
    ]);
    const out = await runAgentCiCommand({
      rawArg: 'workflows',
      cwd: wt,
      loadProjectWorktreesFn: harness.loadProjectWorktreesFn,
      startAgentCiRunFn: harness.startAgentCiRunFn,
    });
    expect(out).toContain('not a file');
  });

  test('happy path: spawns and reports pid', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'noetic-agent-ci-cmd-ok-'));
    const workflow = join(wt, '.github/workflows/test.yml');
    mkdirSync(dirname(workflow), {
      recursive: true,
    });
    writeFileSync(workflow, 'name: test\n');
    const harness = makeHarness([
      {
        projectRoot: wt,
        path: wt,
        branch: 'feature',
        headSha: null,
        current: true,
      },
    ]);
    const out = await runAgentCiCommand({
      rawArg: '.github/workflows/test.yml',
      cwd: resolve(wt),
      loadProjectWorktreesFn: harness.loadProjectWorktreesFn,
      startAgentCiRunFn: harness.startAgentCiRunFn,
    });
    expect(out).toContain('Started agent-ci run');
    expect(out).toContain('pid=4242');
    expect(harness.startAgentCiRunFn).toHaveBeenCalledTimes(1);
    const callArgs = harness.startAgentCiRunFn.mock.calls[0]?.[0];
    expect(callArgs?.workflow).toBe('.github/workflows/test.yml');
    expect(callArgs?.cwd).toBe(wt);
  });
});
