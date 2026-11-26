/**
 * Start a process where an agent runs and hold its stdio — the seam a stdio
 * MCP server that must run beside the agent is started through, with Noetic
 * still its MCP client on the host.
 */

import type {
  AcpTransport,
  Spawn,
  SpawnCommand,
  SubprocessAdapter,
  SubprocessLink,
  SubprocessOpenOptions,
} from '@noetic-tools/types';
import { NoeticConfigError } from '@noetic-tools/types';

/**
 * Each call opens a link through `adapter`, starts `command` there, and
 * closes the link when the process's stream closes.
 *
 * @throws `NoeticConfigError` `SUBPROCESS_CANNOT_OPEN` from the returned `Spawn` when `adapter` has no `open`.
 * @public
 */
export function spawnOn(adapter: SubprocessAdapter, signal?: AbortSignal): Spawn {
  return async (command: SpawnCommand): Promise<AcpTransport> => {
    const link = await openLink(
      adapter,
      {
        signal,
      },
      `'${command.command}'`,
    );
    let process: AcpTransport;
    try {
      process = await link.spawn(command);
    } catch (e) {
      await link.close().catch(() => undefined);
      throw e;
    }
    return {
      readable: process.readable,
      writable: process.writable,
      async close() {
        try {
          await process.close();
        } finally {
          await link.close();
        }
      },
    };
  };
}

/**
 * Open a link through `adapter`, to start `what` (named in the error).
 *
 * @throws `NoeticConfigError` `SUBPROCESS_CANNOT_OPEN` for an adapter with no `open`: it hands back no stdio.
 */
export async function openLink(
  adapter: SubprocessAdapter,
  options: SubprocessOpenOptions,
  what: string,
): Promise<SubprocessLink> {
  if (!adapter.open) {
    throw cannotOpen(
      `The subprocess adapter ${what} runs through has no \`open\`, so it cannot start a process and hold its stdio.`,
    );
  }
  return await adapter.open(options);
}

/** The error for a process that has no adapter with `open` to start through. */
export function cannotOpen(message: string): NoeticConfigError {
  return new NoeticConfigError({
    code: 'SUBPROCESS_CANNOT_OPEN',
    message,
    hint: 'Give the harness `environment: { subprocess: createLocalSubprocessAdapter() }` from @noetic-tools/platform-node, or name another adapter that has `open` (`subprocess: <name>` on the step or the agent).',
  });
}
