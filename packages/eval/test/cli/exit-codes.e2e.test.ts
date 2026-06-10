import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI_PATH = path.resolve(import.meta.dir, '../../src/cli/cli.ts');
const FIXTURE_DIR = path.resolve(import.meta.dir, '../fixtures/cli');
const PACKAGE_DIR = path.resolve(import.meta.dir, '../..');

const E2E_TIMEOUT = 3e4;

interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], cwd: string = PACKAGE_DIR): Promise<CliRun> {
  const proc = Bun.spawn(
    [
      process.execPath,
      CLI_PATH,
      'test',
      ...args,
    ],
    {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        // Keep fixtures deterministic and offline.
        OPENROUTER_API_KEY: '',
      },
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    exitCode,
    stdout,
    stderr,
  };
}

describe('cli exit codes (e2e)', () => {
  test(
    'throwing case -> exit 1',
    async () => {
      const run = await runCli([
        path.join(FIXTURE_DIR, 'failing.eval.ts'),
      ]);
      expect(run.stdout).toContain('0 passed, 1 failed');
      expect(run.exitCode).toBe(1);
    },
    E2E_TIMEOUT,
  );

  test(
    'all-pass suite -> exit 0',
    async () => {
      const run = await runCli([
        path.join(FIXTURE_DIR, 'passing.eval.ts'),
      ]);
      expect(run.stdout).toContain('1 passed, 0 failed');
      expect(run.exitCode).toBe(0);
    },
    E2E_TIMEOUT,
  );

  test(
    'unknown flag -> exit 2',
    async () => {
      const run = await runCli([
        '--regression',
      ]);
      expect(run.stderr).toContain('Unknown flag');
      expect(run.exitCode).toBe(2);
    },
    E2E_TIMEOUT,
  );

  test(
    'invalid --scope value -> exit 2',
    async () => {
      const run = await runCli([
        '--scope',
        'promts-only',
      ]);
      expect(run.stderr).toContain('Invalid --scope value');
      expect(run.exitCode).toBe(2);
    },
    E2E_TIMEOUT,
  );

  test(
    'explicit pattern resolving to nothing -> exit 1',
    async () => {
      const run = await runCli([
        'no-such-eval-file',
      ]);
      expect(run.stderr).toContain('No eval file found');
      expect(run.exitCode).toBe(1);
    },
    E2E_TIMEOUT,
  );

  test(
    'empty discovery without explicit patterns -> exit 0',
    async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noetic-empty-'));
      try {
        const run = await runCli([], emptyDir);
        expect(run.stdout).toContain('No .eval.ts files found');
        expect(run.exitCode).toBe(0);
      } finally {
        fs.rmSync(emptyDir, {
          recursive: true,
          force: true,
        });
      }
    },
    E2E_TIMEOUT,
  );

  test(
    '--check with no baseline -> notice and exit 0',
    async () => {
      const run = await runCli([
        '--check',
        path.join(FIXTURE_DIR, 'passing.eval.ts'),
      ]);
      expect(run.stdout).toContain('No baseline for');
      expect(run.exitCode).toBe(0);
    },
    E2E_TIMEOUT,
  );
});
