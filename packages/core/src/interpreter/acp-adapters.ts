/**
 * Which of the harness's adapters an ACP step uses (spec 27 § The subprocess
 * adapter): the agent's process through `subprocess`, its `fs/*` and
 * `terminal/*` calls through `fs` and `shell`.
 */

import type { AcpAgent, AdapterSet, Context, ContextData, StepAcpAgent } from '@noetic-tools/types';
import type { AcpAdapterNames } from '../runtime/acp-session-store';

/**
 * The adapters `step` uses on `ctx`'s harness, with every unnamed one
 * resolved to its default's name, so a step that names the default and one
 * that names nothing agree.
 *
 * @throws `NoeticConfigError` `ADAPTER_UNKNOWN` for a name the harness lacks.
 */
export function acpAdapterNames<TContext, I, O>(
  step: StepAcpAgent<TContext, I, O>,
  agent: AcpAgent,
  ctx: Context<ContextData>,
): AcpAdapterNames {
  return {
    subprocess: nameIn(ctx.adapters.subprocess, step.subprocess ?? agent.subprocess),
    fs: nameIn(ctx.adapters.fs, step.fs),
    shell: nameIn(ctx.adapters.shell, step.shell),
  };
}

function nameIn<A>(set: AdapterSet<A>, name: string | undefined): string {
  if (name === undefined) {
    return set.defaultName;
  }
  set.get(name);
  return name;
}
