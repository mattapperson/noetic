/**
 * `@noetic-tools/platform-node` — Node-only adapter implementations.
 *
 * Consumers on Node.js ≥ 20 (or any runtime that provides
 * `node:fs/promises`, `node:child_process`, `node:net`, and
 * `Bun.spawn`) import from here to get the local filesystem, shell,
 * subprocess, durable-storage, and per-task IPC implementations.
 *
 * `@noetic-tools/core` ships only contracts and in-memory adapters; the
 * Node-specific implementations live here so portable-runtime
 * consumers never pull `node:*` into their bundle.
 */

export {
  AgentIpcClient,
  type AgentIpcClientOpts,
  type AskUserStreamEvent,
  type HelloInfo,
} from './agent-ipc-client';
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
} from './agent-ipc-protocol';
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
} from './agent-ipc-server';
export {
  type CreateDurableOutboundQueueOptions,
  createDurableOutboundQueue,
  type DurableFrameEntry,
  type DurableOutboundQueue,
} from './durable-outbound-queue';
export {
  type CreateFileStorageOptions,
  createFileStorage,
} from './file-storage';
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
