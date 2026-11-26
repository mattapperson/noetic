/**
 * Start a process where an agent runs and hold its stdio — the seam a stdio
 * MCP server that must run beside the agent is started through, with Noetic
 * still its MCP client on the host.
 */

import type { AcpTransport, Spawn, SpawnCommand, SubprocessAdapter } from '@noetic-tools/types';
import { openLink } from './agent-subprocess';

/**
 * Each call opens a link through `adapter`, starts `command` there, and
 * closes the link when the process's stream closes.
 * @public
 */
export function spawnOn(adapter: SubprocessAdapter, signal?: AbortSignal): Spawn {
  return async (command: SpawnCommand): Promise<AcpTransport> => {
    const link = await openLink(adapter, {
      signal,
    });
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
