/**
 * CLI dispatch smoke tests: spawn the real binary with various session
 * flags and assert on exit code + stderr. These exercise the parseArgs +
 * cli.ts branching without booting the full TUI, so they're quick and
 * don't need the tui-test harness.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli', 'cli.ts');
// Used to satisfy parseArgs's API-key gate without hitting the network.
const FAKE_API_KEY = 'sk-or-v1-test-key';

let sessionsRoot: string;

beforeAll(async () => {
  sessionsRoot = await mkdtemp(join(tmpdir(), 'noetic-dispatch-'));
});

afterAll(async () => {
  await rm(sessionsRoot, {
    recursive: true,
    force: true,
  });
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(args: ReadonlyArray<string>, timeoutMs = 5_000): Promise<RunResult> {
  const proc = Bun.spawn(
    [
      'bun',
      'run',
      CLI,
      '--api-key',
      FAKE_API_KEY,
      ...args,
    ],
    {
      env: {
        ...process.env,
        NOETIC_SESSIONS_DIR: sessionsRoot,
        OPENROUTER_API_KEY: FAKE_API_KEY,
      },
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    },
  );

  const timer = setTimeout(() => {
    proc.kill();
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  return {
    exitCode,
    stdout,
    stderr,
  };
}

describe('--help', () => {
  it('lists the new session flags', async () => {
    const result = await run([
      '--help',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--continue');
    expect(result.stdout).toContain('--resume');
    expect(result.stdout).toContain('--fork-session');
    expect(result.stdout).toContain('--session-id');
    expect(result.stdout).toContain('--no-session-persistence');
    expect(result.stdout).toContain('-n, --name');
  });
});

describe('--session-id validation', () => {
  it('exits 1 with a bad UUID', async () => {
    const result = await run([
      '--session-id',
      'nope',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('must be a valid UUID');
  });
});

describe('--fork-session without -c/-r', () => {
  it('exits 1 with a clear error', async () => {
    const result = await run([
      '--fork-session',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--fork-session requires');
  });
});

describe('--resume <nonexistent-uuid>', () => {
  it('exits 1 with "session not found"', async () => {
    const result = await run([
      '--resume',
      'ffffffff-0000-4000-8000-000000000000',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found');
  });
});

// Note: a test that spawns with a seeded session file and `--continue`
// was intentionally omitted — the discovery step in cli.ts loads any
// `noetic.config.ts` found walking up from the spawn cwd, which overrides
// the `--cwd` flag, making it tricky to target an isolated session
// directory from a spawn-based test without moving into a tmp cwd
// (which would miss the noetic/ workspace and fail plugin resolution).
// The load path is covered by sessions-store.test.ts unit tests.
