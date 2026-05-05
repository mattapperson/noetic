/**
 * Node-only adapter barrel. Consumers on Node (or any runtime that
 * provides `node:fs/promises`, `node:child_process`, and `Bun.spawn`)
 * import from here to get the local implementations.
 *
 * This barrel is published as `@noetic/core/adapters/node`. Keeping
 * the Node-specific imports off the main entry point lets callers on
 * portable runtimes pay no cost for filesystem/process adapters they
 * won't use.
 */

export { createLocalFsAdapter } from './local-fs-adapter';
export {
  type CreateLocalShellAdapterOptions,
  createLocalShellAdapter,
  type LocalShellAdapter,
} from './local-shell-adapter';
export {
  type CreateLocalSubprocessAdapterOptions,
  createLocalSubprocessAdapter,
  defaultProcessSignaller,
  type ProcessSignaller,
  type SubprocessSignal,
} from './local-subprocess-adapter';
export {
  AgentIpcClient,
  type AgentIpcClientOpts,
  type AskUserStreamEvent,
  type HelloInfo,
} from './node/agent-ipc-client';
export {
  type AskUserPendingFrame,
  AskUserPendingFrameSchema,
  type ClientFrame,
  ClientFrameSchema,
  encodeFrame,
  PROTOCOL_VERSION,
  parseClientFrame,
  parseServerFrame,
  type ServerFrame,
  ServerFrameSchema,
} from './node/agent-ipc-protocol';
export {
  type AgentHarnessContract,
  AgentIpcServer,
  type AgentIpcServerOpts,
  type ChatHistoryStore,
  type IpcAskUserService,
  type IpcHarness,
  type TaskLogEntry,
  type TaskLogger,
  unlinkSocketSync,
} from './node/agent-ipc-server';
export {
  type CreateDurableOutboundQueueOptions,
  createDurableOutboundQueue,
  type DurableFrameEntry,
  type DurableOutboundQueue,
} from './node/durable-outbound-queue';
