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
