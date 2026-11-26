/**
 * Where the keeper tests run their agent: a local process, a WebSocket
 * runner, or a runner started over stdio (as ssh or docker exec would).
 */

import { fileURLToPath } from 'node:url';
import type { SubprocessAdapter } from '@noetic-tools/types';
import { commandSubprocess, webSocketSubprocess } from '../../src/remote';

const BIN = fileURLToPath(new URL('../../src/bin.ts', import.meta.url));

export type SubprocessKind = 'local' | 'ws' | 'stdio';

export function subprocessFor(kind: string): SubprocessAdapter | undefined {
  if (kind === 'ws') {
    return webSocketSubprocess({
      url: process.env.NOETIC_TEST_RUNNER_URL ?? '',
      token: process.env.NOETIC_TEST_RUNNER_TOKEN ?? '',
    });
  }
  if (kind === 'stdio') {
    return commandSubprocess({
      command: process.execPath,
      args: [
        BIN,
        'serve',
        '--stdio',
      ],
    });
  }
  return undefined;
}
