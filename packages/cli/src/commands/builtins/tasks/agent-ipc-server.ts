/**
 * CLI re-export of the SDK's Node-backed IPC server, plus a wrapper
 * that defaults `fs` to `createLocalFsAdapter()` so existing CLI call
 * sites can omit it.
 */

import * as sdk from '@noetic/code-agent/tasks';
import { createLocalFsAdapter } from '@noetic/core/adapters/node';

export type { AgentHarnessContract, IpcHarness } from '@noetic/code-agent/tasks';
export { unlinkSocketSync } from '@noetic/code-agent/tasks';

/** CLI-side args: `fs` is optional and defaults to a local adapter. */
export interface AgentIpcServerOpts extends Omit<sdk.AgentIpcServerOpts, 'fs'> {
  readonly fs?: sdk.AgentIpcServerOpts['fs'];
}

export class AgentIpcServer extends sdk.AgentIpcServer {
  constructor(opts: AgentIpcServerOpts) {
    super({
      ...opts,
      fs: opts.fs ?? createLocalFsAdapter(),
    });
  }
}
