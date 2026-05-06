import { describe, expect, it } from 'bun:test';
import { TaskReviewStatus } from '@noetic/code-agent/tasks/schema';
import { listTasks, loadTask } from '@noetic/code-agent/tasks/store/fs-node';
import type { CliStreams } from '../../src/tasks/runtime/cli.js';
import { runTasksCli } from '../../src/tasks/runtime/cli.js';
import { makeStoreContext } from './_helpers.js';

interface CapturedStreams {
  stdout: string;
  stderr: string;
  streams: CliStreams;
}

function captureStreams(): CapturedStreams {
  const captured: CapturedStreams = {
    stdout: '',
    stderr: '',
    streams: {
      stdout: {
        write(chunk: string): boolean {
          captured.stdout += chunk;
          return true;
        },
      },
      stderr: {
        write(chunk: string): boolean {
          captured.stderr += chunk;
          return true;
        },
      },
    },
  };
  return captured;
}

describe('runTasksCli — help & dispatch', () => {
  it('prints help when called with --help', async () => {
    const ctx = makeStoreContext();
    const cap = captureStreams();
    const code = await runTasksCli(
      [
        '--help',
      ],
      {
        streams: cap.streams,
        projectRoot: ctx.projectRoot,
        tasksRoot: ctx.tasksRoot,
        fs: ctx.fs,
      },
    );
    expect(code).toBe(0);
    expect(cap.stdout).toContain('Usage: noetic tasks');
    expect(cap.stdout).toContain('create');
    expect(cap.stdout).toContain('archive');
  });

  it('exits 1 with help on an unknown verb', async () => {
    const ctx = makeStoreContext();
    const cap = captureStreams();
    const code = await runTasksCli(
      [
        'no-such-verb',
      ],
      {
        streams: cap.streams,
        projectRoot: ctx.projectRoot,
        tasksRoot: ctx.tasksRoot,
        fs: ctx.fs,
      },
    );
    expect(code).toBe(1);
    expect(cap.stderr).toContain('Unknown verb');
  });
});

describe('runTasksCli — verbs', () => {
  it('create dispatches to createTaskHandler and prints the task json', async () => {
    const ctx = makeStoreContext();
    const cap = captureStreams();
    const code = await runTasksCli(
      [
        'create',
        '--title',
        'CLI dispatch test',
      ],
      {
        streams: cap.streams,
        projectRoot: ctx.projectRoot,
        tasksRoot: ctx.tasksRoot,
        fs: ctx.fs,
      },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.title).toBe('CLI dispatch test');
    const all = await listTasks(ctx);
    expect(all.length).toBe(1);
  });

  it('list returns the tasks json array', async () => {
    const ctx = makeStoreContext();
    await runTasksCli(
      [
        'create',
        '--title',
        'A',
      ],
      {
        streams: captureStreams().streams,
        projectRoot: ctx.projectRoot,
        tasksRoot: ctx.tasksRoot,
        fs: ctx.fs,
      },
    );
    const cap = captureStreams();
    const code = await runTasksCli(
      [
        'list',
      ],
      {
        streams: cap.streams,
        projectRoot: ctx.projectRoot,
        tasksRoot: ctx.tasksRoot,
        fs: ctx.fs,
      },
    );
    expect(code).toBe(0);
    const arr = JSON.parse(cap.stdout);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBe(1);
  });

  it('move dispatches with positional column argument', async () => {
    const ctx = makeStoreContext();
    const createCap = captureStreams();
    await runTasksCli(
      [
        'create',
        '--title',
        'Move dispatch',
      ],
      {
        streams: createCap.streams,
        projectRoot: ctx.projectRoot,
        tasksRoot: ctx.tasksRoot,
        fs: ctx.fs,
      },
    );
    const created = JSON.parse(createCap.stdout);
    const cap = captureStreams();
    const code = await runTasksCli(
      [
        'move',
        created.id,
        'in_progress',
      ],
      {
        streams: cap.streams,
        projectRoot: ctx.projectRoot,
        tasksRoot: ctx.tasksRoot,
        fs: ctx.fs,
      },
    );
    expect(code).toBe(0);
    const reloaded = await loadTask(ctx, created.id);
    expect(reloaded.reviewStatus).toBe(TaskReviewStatus.Reviewing);
  });

  it('archive flips archivedAt', async () => {
    const ctx = makeStoreContext();
    const createCap = captureStreams();
    await runTasksCli(
      [
        'create',
        '--title',
        'Archive dispatch',
      ],
      {
        streams: createCap.streams,
        projectRoot: ctx.projectRoot,
        tasksRoot: ctx.tasksRoot,
        fs: ctx.fs,
      },
    );
    const created = JSON.parse(createCap.stdout);
    const code = await runTasksCli(
      [
        'archive',
        created.id,
      ],
      {
        streams: captureStreams().streams,
        projectRoot: ctx.projectRoot,
        tasksRoot: ctx.tasksRoot,
        fs: ctx.fs,
      },
    );
    expect(code).toBe(0);
    const reloaded = await loadTask(ctx, created.id);
    expect(reloaded.archivedAt).not.toBeNull();
  });

  it('autopilot toggles via boolean positional', async () => {
    const ctx = makeStoreContext();
    const createCap = captureStreams();
    await runTasksCli(
      [
        'create',
        '--title',
        'Autopilot dispatch',
      ],
      {
        streams: createCap.streams,
        projectRoot: ctx.projectRoot,
        tasksRoot: ctx.tasksRoot,
        fs: ctx.fs,
      },
    );
    const created = JSON.parse(createCap.stdout);
    const cap = captureStreams();
    const code = await runTasksCli(
      [
        'autopilot',
        created.id,
        'true',
      ],
      {
        streams: cap.streams,
        projectRoot: ctx.projectRoot,
        tasksRoot: ctx.tasksRoot,
        fs: ctx.fs,
      },
    );
    expect(code).toBe(0);
    const reloaded = await loadTask(ctx, created.id);
    expect(reloaded.autopilotEnabled).toBe(true);
  });

  it('returns 1 on missing required argument', async () => {
    const ctx = makeStoreContext();
    const cap = captureStreams();
    const code = await runTasksCli(
      [
        'create',
      ],
      {
        streams: cap.streams,
        projectRoot: ctx.projectRoot,
        tasksRoot: ctx.tasksRoot,
        fs: ctx.fs,
      },
    );
    expect(code).toBe(1);
    expect(cap.stderr).toContain('Missing required --title');
  });

  it('plan rejects in headless mode with a friendly error', async () => {
    const ctx = makeStoreContext();
    const cap = captureStreams();
    const code = await runTasksCli(
      [
        'plan',
      ],
      {
        streams: cap.streams,
        projectRoot: ctx.projectRoot,
        tasksRoot: ctx.tasksRoot,
        fs: ctx.fs,
      },
    );
    expect(code).toBe(1);
    expect(cap.stderr).toContain('plan');
  });

  it('delete removes the task record', async () => {
    const ctx = makeStoreContext();
    const createCap = captureStreams();
    await runTasksCli(
      [
        'create',
        '--title',
        'Delete dispatch',
      ],
      {
        streams: createCap.streams,
        projectRoot: ctx.projectRoot,
        tasksRoot: ctx.tasksRoot,
        fs: ctx.fs,
      },
    );
    const created = JSON.parse(createCap.stdout);
    await runTasksCli(
      [
        'delete',
        created.id,
      ],
      {
        streams: captureStreams().streams,
        projectRoot: ctx.projectRoot,
        tasksRoot: ctx.tasksRoot,
        fs: ctx.fs,
      },
    );
    expect(await listTasks(ctx)).toEqual([]);
  });
});
