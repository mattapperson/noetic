#!/usr/bin/env bun

/**
 * @noetic-tools/cli entry point.
 *
 * Dispatches to one of three bootstraps based on argv[2]:
 * - `tasks`                  → bootstrap-tasks (headless task CLI)
 * - `daemon` | `tasks-daemon`→ bootstrap-daemon (internal re-exec target)
 * - anything else            → bootstrap-interactive (default TUI path)
 */

import { readNetrcPassword } from './netrc.js';
import { installWorkspaceProxy } from './workspace-proxy.js';

// Backfill OPENROUTER_API_KEY from ~/.netrc (machine: openrouter.ai) when the
// env var is unset. Runs before any bootstrap so every entry path (interactive
// TUI, tasks, daemon) sees the resolved key. An explicit --api-key flag still
// wins because args parsing reads it after this point.
if (!process.env.OPENROUTER_API_KEY) {
  const fromNetrc = readNetrcPassword('openrouter.ai');
  if (fromNetrc !== undefined && fromNetrc.length > 0) {
    process.env.OPENROUTER_API_KEY = fromNetrc;
  }
}

const subcommand = process.argv[2];

if (subcommand === 'tasks') {
  const { runTasksEntry } = await import('./bootstrap-tasks.js');
  const exitCode = await runTasksEntry(process.argv);
  process.exit(exitCode);
}

if (subcommand === 'daemon' || subcommand === 'tasks-daemon') {
  const { runDaemonEntry } = await import('./bootstrap-daemon.js');
  await runDaemonEntry(process.argv);
  process.exit(0);
}

// Only the interactive TUI path needs cross-checkout React deduping; the
// `tasks` and `daemon` subcommands above don't render Ink. See workspace-proxy.ts.
installWorkspaceProxy();

const { runInteractiveEntry } = await import('./bootstrap-interactive.js');
await runInteractiveEntry(process.argv);
