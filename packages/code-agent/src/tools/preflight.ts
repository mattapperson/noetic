/**
 * Shared shell-command preflight.
 *
 * Single gate every shell-execution surface (Bash tool, skill inline
 * `!commands`, AGENT.md embedded commands) runs before handing a command to
 * the shell adapter: command validation (banned commands, high-risk
 * patterns, interactive TUIs) followed by the mutation-policy check for
 * probably-mutating commands.
 */

import type { MutationPolicy } from './mutation-policy.js';
import { isProbablyMutatingShellCommand } from './mutation-policy.js';
import { validateCommand } from './security.js';

export type ShellPreflightResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: string;
    };

export interface ShellPreflightOpts {
  /** Working directory the command would run in (passed to the policy check). */
  cwd: string;
  /** Optional mutation policy consulted for probably-mutating commands. */
  mutationPolicy?: MutationPolicy;
}

/**
 * Run the full Bash-tool preflight pipeline on a shell command.
 *
 * Returns `{ ok: false, reason }` when the command is invalid (banned,
 * high-risk, interactive) or when the mutation policy denies it; otherwise
 * `{ ok: true }`. Never throws.
 */
export async function preflightShellCommand(
  command: string,
  opts: ShellPreflightOpts,
): Promise<ShellPreflightResult> {
  const validation = validateCommand(command);
  if (!validation.valid) {
    return {
      ok: false,
      reason: validation.error ?? 'Invalid command',
    };
  }
  if (!opts.mutationPolicy || !isProbablyMutatingShellCommand(command)) {
    return {
      ok: true,
    };
  }
  const decision = await opts.mutationPolicy.check({
    kind: 'bash',
    cwd: opts.cwd,
    command,
  });
  if (decision.allowed) {
    return {
      ok: true,
    };
  }
  return {
    ok: false,
    reason: decision.message,
  };
}
