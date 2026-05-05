/**
 * Throwing-stub adapters for the SDK launchers.
 *
 * The launchers in `@noetic/code-agent/tasks` must not link against
 * `node:child_process` transitively — callers on portable runtimes
 * should be able to import the module without paying that cost. But
 * the launchers still accept an *optional* `subprocess` argument so
 * the historical API works on Node when the caller also imports
 * `createLocalSubprocessAdapter` from `@noetic/core/adapters/node`.
 *
 * Rather than defaulting to a real Node adapter (which would pull the
 * Node imports into every bundle), we default to these stubs: they
 * throw with an actionable message the moment the launcher tries to
 * spawn. Tree-shakers drop the stubs entirely when a caller supplies
 * their own `subprocess`.
 */

import type {
  ProcessSignaller,
  SubprocessAdapter,
  SubprocessControlResult,
  SubprocessHandle,
  SubprocessStopResult,
} from '@noetic/core';

const REQUIRE_NODE_ADAPTER_MESSAGE =
  'This launcher requires a `subprocess` SubprocessAdapter. On Node, import ' +
  '`createLocalSubprocessAdapter` from `@noetic/core/adapters/node` and pass ' +
  'it via the launcher options.';

const REQUIRE_NODE_SIGNALLER_MESSAGE =
  'This launcher requires a `signaller` ProcessSignaller. On Node, import ' +
  '`defaultProcessSignaller` from `@noetic/core/adapters/node` and pass it ' +
  'via the launcher options.';

/**
 * SubprocessAdapter stub. Every method throws with an actionable message
 * — the launcher calls `spawn` first, so that's the only method a
 * typical caller hits, but the rest are safe to call in tests where
 * only pause/resume are needed.
 */
export function requireNodeSubprocessAdapter(): SubprocessAdapter {
  return {
    async spawn(): Promise<SubprocessHandle> {
      throw new Error(REQUIRE_NODE_ADAPTER_MESSAGE);
    },
    async get(): Promise<SubprocessHandle | null> {
      return null;
    },
    async stop(handleId): Promise<SubprocessStopResult> {
      return {
        kind: 'not_found',
        handleId,
      };
    },
    async pause(handleId): Promise<SubprocessControlResult> {
      return {
        kind: 'not_found',
        handleId,
      };
    },
    async resume(handleId): Promise<SubprocessControlResult> {
      return {
        kind: 'not_found',
        handleId,
      };
    },
    async isAlive(): Promise<boolean> {
      return false;
    },
  };
}

/** ProcessSignaller stub — throws on signal, reports "not alive". */
export const requireNodeProcessSignaller: ProcessSignaller = {
  kill() {
    throw new Error(REQUIRE_NODE_SIGNALLER_MESSAGE);
  },
  isAlive() {
    return false;
  },
  startTime() {
    return null;
  },
};
