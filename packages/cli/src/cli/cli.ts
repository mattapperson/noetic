#!/usr/bin/env bun

/**
 * @noetic-tools/cli entry point.
 *
 * Dispatches to one of three bootstraps based on argv[2]:
 * - `tasks`                  → bootstrap-tasks (headless task CLI)
 * - `daemon` | `tasks-daemon`→ bootstrap-daemon (internal re-exec target)
 * - anything else            → bootstrap-interactive (default TUI path)
 */

import { installWorkspaceProxy } from './workspace-proxy.js';

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
