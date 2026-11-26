/**
 * Where the keeper tests run their agent: a local process, a WebSocket
 * runner, or a runner started over stdio (as ssh or docker exec would).
 */

import { fileURLToPath } from 'node:url';
import type { SubprocessAdapter, SubprocessChoice } from '@noetic-tools/types';
import { createLocalSubprocessAdapter } from '../../../platform-node/src/local-subprocess-adapter';
import {
  createCommandSubprocessAdapter,
  createWebSocketSubprocessAdapter,
} from '../../../platform-node/src/runner-subprocess-adapters';
import { through } from '../_helpers';

const BIN = fileURLToPath(new URL('../../src/bin.ts', import.meta.url));

export type SubprocessKind = 'local' | 'ws' | 'stdio';

/** What a harness whose only subprocess adapter is `kind`'s hands an agent's `connect`. */
export function subprocessFor(kind: string): SubprocessChoice {
  return through(adapterFor(kind));
}

function adapterFor(kind: string): SubprocessAdapter {
  if (kind === 'ws') {
    return createWebSocketSubprocessAdapter({
      url: process.env.NOETIC_TEST_RUNNER_URL ?? '',
      token: process.env.NOETIC_TEST_RUNNER_TOKEN ?? '',
    });
  }
  if (kind === 'stdio') {
    return createCommandSubprocessAdapter({
      command: process.execPath,
      args: [
        BIN,
        'serve',
        '--stdio',
      ],
    });
  }
  return createLocalSubprocessAdapter();
}
