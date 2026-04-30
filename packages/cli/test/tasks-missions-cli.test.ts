import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openTasksDatabaseAtPath } from '../src/commands/builtins/tasks/db/index.js';
import { dispatchMissionVerb } from '../src/commands/builtins/tasks/missions/cli.js';
import {
  createMission,
  missionEvents,
  resetOpenMissionsDatabase,
  setOpenMissionsDatabase,
} from '../src/commands/builtins/tasks/missions/store.js';

interface CaptureBuffers {
  stdout: {
    write: (chunk: string) => boolean;
  };
  stderr: {
    write: (chunk: string) => boolean;
  };
  out: () => string;
  err: () => string;
}

function makeCapture(): CaptureBuffers {
  let outBuf = '';
  let errBuf = '';
  return {
    stdout: {
      write: (chunk: string) => {
        outBuf += chunk;
        return true;
      },
    },
    stderr: {
      write: (chunk: string) => {
        errBuf += chunk;
        return true;
      },
    },
    out: () => outBuf,
    err: () => errBuf,
  };
}

let cwd: string;
let dbPath: string;
let originalExitCode: typeof process.exitCode;
let ensureCount = 0;
const stubEnsureDaemon = (_target: string): void => {
  ensureCount += 1;
};

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'noetic-missions-cli-'));
  dbPath = join(cwd, 'tasks.sqlite');
  setOpenMissionsDatabase(() => openTasksDatabaseAtPath(dbPath));
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  ensureCount = 0;
});

afterEach(() => {
  missionEvents.removeAllListeners();
  resetOpenMissionsDatabase();
  process.exitCode = originalExitCode;
});

describe('dispatchMissionVerb', () => {
  test('prints usage when no verb given', async () => {
    const cap = makeCapture();
    await dispatchMissionVerb([], cwd, {
      stdout: cap.stdout,
      stderr: cap.stderr,
      ensureDaemonFn: stubEnsureDaemon,
    });
    expect(cap.out()).toContain('Usage: noetic mission');
    expect(process.exitCode).toBeUndefined();
  });

  test('prints usage on help/--help/-h', async () => {
    for (const flag of [
      'help',
      '--help',
      '-h',
    ]) {
      const cap = makeCapture();
      await dispatchMissionVerb(
        [
          flag,
        ],
        cwd,
        {
          stdout: cap.stdout,
          stderr: cap.stderr,
          ensureDaemonFn: stubEnsureDaemon,
        },
      );
      expect(cap.out()).toContain('Usage: noetic mission');
    }
  });

  test('unknown verb writes error and sets exitCode 1', async () => {
    const cap = makeCapture();
    await dispatchMissionVerb(
      [
        'frobnicate',
      ],
      cwd,
      {
        stdout: cap.stdout,
        stderr: cap.stderr,
        ensureDaemonFn: stubEnsureDaemon,
      },
    );
    expect(cap.err()).toContain('Unknown verb: frobnicate');
    expect(process.exitCode).toBe(1);
  });

  test('create with title arg seeds a row and prints the id', async () => {
    const cap = makeCapture();
    let promptIndex = 0;
    const promptLine = async (): Promise<string> => {
      promptIndex += 1;
      // First prompt is description (we already passed title via argv).
      return promptIndex === 1 ? 'A short description' : '';
    };
    await dispatchMissionVerb(
      [
        'create',
        'My',
        'Mission',
      ],
      cwd,
      {
        stdout: cap.stdout,
        stderr: cap.stderr,
        promptLine,
        ensureDaemonFn: stubEnsureDaemon,
      },
    );
    expect(cap.out()).toContain('Created mission ');
    expect(cap.out()).toContain('noetic mission show ');
  });

  test('create without title prompts for title — empty title is an error', async () => {
    const cap = makeCapture();
    const promptLine = async (): Promise<string> => '';
    await dispatchMissionVerb(
      [
        'create',
      ],
      cwd,
      {
        stdout: cap.stdout,
        stderr: cap.stderr,
        promptLine,
        ensureDaemonFn: stubEnsureDaemon,
      },
    );
    expect(cap.err()).toContain('mission title is required');
    expect(process.exitCode).toBe(1);
  });

  test('list with no missions prints a friendly empty notice', async () => {
    const cap = makeCapture();
    await dispatchMissionVerb(
      [
        'list',
      ],
      cwd,
      {
        stdout: cap.stdout,
        stderr: cap.stderr,
        ensureDaemonFn: stubEnsureDaemon,
      },
    );
    expect(cap.out()).toContain('No missions yet.');
  });

  test('list groups missions by status', async () => {
    createMission(cwd, {
      title: 'Alpha',
    });
    createMission(cwd, {
      title: 'Beta',
    });
    const cap = makeCapture();
    await dispatchMissionVerb(
      [
        'list',
      ],
      cwd,
      {
        stdout: cap.stdout,
        stderr: cap.stderr,
        ensureDaemonFn: stubEnsureDaemon,
      },
    );
    expect(cap.out()).toContain('# planning (2)');
    expect(cap.out()).toContain('Alpha');
    expect(cap.out()).toContain('Beta');
  });

  test('show without id is an error', async () => {
    const cap = makeCapture();
    await dispatchMissionVerb(
      [
        'show',
      ],
      cwd,
      {
        stdout: cap.stdout,
        stderr: cap.stderr,
        ensureDaemonFn: stubEnsureDaemon,
      },
    );
    expect(cap.err()).toContain('Usage: noetic mission show');
    expect(process.exitCode).toBe(1);
  });

  test('show with unknown id is an error', async () => {
    const cap = makeCapture();
    await dispatchMissionVerb(
      [
        'show',
        'no-such-id',
      ],
      cwd,
      {
        stdout: cap.stdout,
        stderr: cap.stderr,
        ensureDaemonFn: stubEnsureDaemon,
      },
    );
    expect(cap.err()).toContain('not found');
    expect(process.exitCode).toBe(1);
  });

  test('show prints the hierarchy as an indented tree', async () => {
    const created = createMission(cwd, {
      title: 'Hierarchy mission',
    });
    const cap = makeCapture();
    await dispatchMissionVerb(
      [
        'show',
        created.id,
      ],
      cwd,
      {
        stdout: cap.stdout,
        stderr: cap.stderr,
        ensureDaemonFn: stubEnsureDaemon,
      },
    );
    expect(cap.out()).toContain(created.id);
    expect(cap.out()).toContain('Hierarchy mission');
  });

  test('activate-slice without id is an error', async () => {
    const cap = makeCapture();
    await dispatchMissionVerb(
      [
        'activate-slice',
      ],
      cwd,
      {
        stdout: cap.stdout,
        stderr: cap.stderr,
        ensureDaemonFn: stubEnsureDaemon,
      },
    );
    expect(cap.err()).toContain('Usage: noetic mission activate-slice');
    expect(process.exitCode).toBe(1);
  });

  test('activate-slice with bogus id is an error', async () => {
    const cap = makeCapture();
    await dispatchMissionVerb(
      [
        'activate-slice',
        'no-such-slice',
      ],
      cwd,
      {
        stdout: cap.stdout,
        stderr: cap.stderr,
        ensureDaemonFn: stubEnsureDaemon,
      },
    );
    expect(cap.err()).toContain('Error');
    expect(process.exitCode).toBe(1);
    expect(ensureCount).toBe(0);
  });

  test('delete without id is an error', async () => {
    const cap = makeCapture();
    await dispatchMissionVerb(
      [
        'delete',
      ],
      cwd,
      {
        stdout: cap.stdout,
        stderr: cap.stderr,
        ensureDaemonFn: stubEnsureDaemon,
      },
    );
    expect(cap.err()).toContain('Usage: noetic mission delete');
    expect(process.exitCode).toBe(1);
  });

  test('delete with unknown id is an error', async () => {
    const cap = makeCapture();
    await dispatchMissionVerb(
      [
        'delete',
        'no-such-mission',
      ],
      cwd,
      {
        stdout: cap.stdout,
        stderr: cap.stderr,
        ensureDaemonFn: stubEnsureDaemon,
      },
    );
    expect(cap.err()).toContain('not found');
    expect(process.exitCode).toBe(1);
  });

  test('delete removes the mission', async () => {
    const created = createMission(cwd, {
      title: 'To delete',
    });
    const cap = makeCapture();
    await dispatchMissionVerb(
      [
        'delete',
        created.id,
      ],
      cwd,
      {
        stdout: cap.stdout,
        stderr: cap.stderr,
        ensureDaemonFn: stubEnsureDaemon,
      },
    );
    expect(cap.out()).toContain('Deleted mission');
  });

  test('autopilot rejects bad arguments', async () => {
    const created = createMission(cwd, {
      title: 'AP',
    });
    const cap = makeCapture();
    await dispatchMissionVerb(
      [
        'autopilot',
        'maybe',
        created.id,
      ],
      cwd,
      {
        stdout: cap.stdout,
        stderr: cap.stderr,
        ensureDaemonFn: stubEnsureDaemon,
      },
    );
    expect(cap.err()).toContain('Usage: noetic mission autopilot');
    expect(process.exitCode).toBe(1);
  });

  test('autopilot rejects unknown mission', async () => {
    const cap = makeCapture();
    await dispatchMissionVerb(
      [
        'autopilot',
        'on',
        'no-such-id',
      ],
      cwd,
      {
        stdout: cap.stdout,
        stderr: cap.stderr,
        ensureDaemonFn: stubEnsureDaemon,
      },
    );
    expect(cap.err()).toContain('not found');
    expect(process.exitCode).toBe(1);
  });

  test('autopilot on calls ensureDaemonFn; off does not', async () => {
    const created = createMission(cwd, {
      title: 'AP',
    });
    {
      const cap = makeCapture();
      await dispatchMissionVerb(
        [
          'autopilot',
          'on',
          created.id,
        ],
        cwd,
        {
          stdout: cap.stdout,
          stderr: cap.stderr,
          ensureDaemonFn: stubEnsureDaemon,
        },
      );
      expect(cap.out()).toContain('Autopilot enabled');
    }
    assert.equal(ensureCount, 1);
    {
      const cap = makeCapture();
      await dispatchMissionVerb(
        [
          'autopilot',
          'off',
          created.id,
        ],
        cwd,
        {
          stdout: cap.stdout,
          stderr: cap.stderr,
          ensureDaemonFn: stubEnsureDaemon,
        },
      );
      expect(cap.out()).toContain('Autopilot disabled');
    }
    assert.equal(ensureCount, 1);
  });
});
