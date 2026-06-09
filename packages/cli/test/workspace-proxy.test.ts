/**
 * Smoke test for the workspace-proxy startup hook. Spawns the CLI binary in a
 * subprocess, points it at a generated noetic config that imports a plugin by
 * absolute path into the main checkout, and asserts the TUI starts without
 * the "Invalid hook call" / two-React-instances crash.
 */

import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ENTRY = resolve(__dirname, '..', 'src', 'cli', 'cli.ts');
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

function isWorktreeCheckout(): boolean {
  // The proxy is a no-op when not running from a git worktree, so this test
  // only meaningfully exercises the proxy when the test process itself runs
  // inside a worktree of the noetic monorepo.
  const dotGit = resolve(REPO_ROOT, '.git');
  if (!existsSync(dotGit)) {
    return false;
  }
  return statSync(dotGit).isFile();
}

describe('workspace proxy', () => {
  it.skipIf(!isWorktreeCheckout())(
    'lets the TUI render when a plugin is imported by absolute main-repo path',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'noetic-cli-wsproxy-'));
      const configPath = join(dir, 'noetic.config.ts');
      const mainPluginPath = resolve(REPO_ROOT, 'packages', 'plugin-powerline');

      await writeFile(
        configPath,
        [
          `import powerline from '${mainPluginPath}';`,
          'export default {',
          "  model: 'anthropic/claude-sonnet-4',",
          '  cwd: process.cwd(),',
          "  apiKey: 'test-key',",
          '  maxTurns: 1,',
          "  plugins: [powerline({ preset: 'default', nerdFonts: false })],",
          '};',
        ].join('\n'),
        'utf8',
      );

      const child = spawn(
        'bun',
        [
          'run',
          CLI_ENTRY,
          '--api-key',
          'test-key',
        ],
        {
          cwd: dir,
          stdio: [
            'pipe',
            'pipe',
            'pipe',
          ],
        },
      );

      let stderr = '';
      const errorMarkers = [
        'Invalid hook call',
        "evaluating 'dispatcher.useContext'",
      ];
      const sawError = new Promise<boolean>((resolve) => {
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
          if (errorMarkers.some((marker) => stderr.includes(marker))) {
            resolve(true);
          }
        });
      });
      const timeout = new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 3000);
      });

      // Without the proxy fix, the process emits "Invalid hook call" within
      // the first second. Race the error against a 3s ceiling so the test
      // exits early on regression and only waits the full window on success.
      await Promise.race([
        sawError,
        timeout,
      ]);
      // SIGKILL so the test never leaks the child. The TUI binds raw stdin,
      // and waiting on `exit`/`close` here hangs the runner under Bun (the
      // pipes don't drain because nothing is reading them). The `kill` syscall
      // is synchronous and the OS reaps the child regardless.
      child.kill('SIGKILL');

      expect(stderr).not.toContain('Invalid hook call');
      expect(stderr).not.toContain("evaluating 'dispatcher.useContext'");
    },
    10_000,
  );
});
