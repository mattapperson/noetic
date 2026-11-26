/**
 * Subprocess adapters that run ACP agents and the processes beside them. They
 * run no Noetic step children, so every step-side member answers that nothing
 * runs there.
 */

import type { SubprocessAdapter, SubprocessLink, SubprocessOpenOptions } from '@noetic-tools/types';
import { NoeticConfigError } from '@noetic-tools/types';

/**
 * A subprocess adapter that runs agents: it always has `open`, and runs no
 * step subprocesses.
 * @public
 */
export interface AgentSubprocessAdapter extends SubprocessAdapter {
  open(options: SubprocessOpenOptions): Promise<SubprocessLink>;
}

/** An {@link AgentSubprocessAdapter} that opens links with `open`; `name` names it in errors. */
export function agentSubprocess(
  name: string,
  open: AgentSubprocessAdapter['open'],
): AgentSubprocessAdapter {
  return {
    open,
    async spawn() {
      throw new NoeticConfigError({
        code: 'ACP_SUBPROCESS_RUNS_NO_STEPS',
        message: `${name} runs ACP agents and the processes beside them; it runs no step subprocesses.`,
        hint: `Give this adapter to an agent (\`claudeCode({ subprocess })\`). For \`environment.subprocess\`, use an adapter that runs steps and add an \`open\` that calls this adapter's.`,
      });
    },
    get: async () => null,
    reattach: async () => null,
    listLive: async () => [],
    isAlive: async () => false,
    stop: async (handleId) => ({
      kind: 'not_found',
      handleId,
    }),
    pause: async (handleId) => ({
      kind: 'not_found',
      handleId,
    }),
    resume: async (handleId) => ({
      kind: 'not_found',
      handleId,
    }),
  };
}

/**
 * Open a link through `adapter`. Throws for an adapter with no `open`: such
 * an adapter hands back no stdio, so no agent can run there.
 */
export async function openLink(
  adapter: SubprocessAdapter,
  options: SubprocessOpenOptions,
): Promise<SubprocessLink> {
  if (!adapter.open) {
    throw new NoeticConfigError({
      code: 'ACP_SUBPROCESS_CANNOT_OPEN',
      message: 'This subprocess adapter has no `open`, so no ACP agent can run there.',
      hint: 'Use an adapter with `open` — `localSubprocess()` from @noetic-tools/acp/stdio, or `webSocketSubprocess()` / `commandSubprocess()` from @noetic-tools/acp/remote — or add `open` to this one.',
    });
  }
  return await adapter.open(options);
}
