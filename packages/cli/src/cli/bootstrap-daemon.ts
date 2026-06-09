/**
 * Daemon subcommand entry — internal re-exec target for `ensureDaemon`.
 *
 * NOT a user-facing command. Users never type `noetic daemon` directly;
 * the interactive TUI and `noetic tasks <verb>` both spawn it
 * transparently. Kept undocumented (no help-output entry) on purpose.
 */

export async function runDaemonEntry(argv: string[]): Promise<void> {
  const daemonCwd = daemonCwdFromArgs(argv) ?? process.cwd();
  const { runDaemon } = await import('../daemon-runtime/runtime.js');
  await runDaemon(daemonCwd);
}

function daemonCwdFromArgs(argv: string[]): string | null {
  const idx = argv.indexOf('--cwd');
  if (idx < 0) {
    return null;
  }
  return argv[idx + 1] ?? null;
}
