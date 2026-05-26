/**
 * Tasks subcommand entry — handles `noetic tasks <verb> ...`.
 *
 * Split out of `cli.ts` so the top-level dispatcher stays small and the
 * tasks branch owns its own daemon-bootstrap logic.
 */

export async function runTasksEntry(argv: string[]): Promise<number> {
  const { runTasksCli } = await import('../tasks/runtime/cli.js');
  const { ensureDaemon } = await import('../daemon-runtime/runtime.js');
  return runTasksCli(argv.slice(3), {
    ensureTaskRuntime(projectRoot) {
      if (process.env.NOETIC_DAEMON === '1') {
        return {};
      }
      try {
        ensureDaemon(projectRoot);
        return {};
      } catch (err) {
        return {
          warning: formatCliError(err),
        };
      }
    },
  });
}

function formatCliError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
