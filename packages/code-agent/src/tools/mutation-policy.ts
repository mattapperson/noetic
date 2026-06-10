import type { READONLY_BANNED_SPAWN_COMMANDS } from './security.js';
import { getFirstCommand } from './security.js';

export type MutationKind = 'write' | 'edit' | 'bash' | 'interactive-terminal';

export interface MutationPolicyRequest {
  kind: MutationKind;
  cwd: string;
  path?: string;
  command?: string;
  action?: string;
}

export type MutationPolicyDecision =
  | {
      allowed: true;
    }
  | {
      allowed: false;
      message: string;
    };

export interface MutationPolicy {
  check(request: MutationPolicyRequest): Promise<MutationPolicyDecision>;
}

export const ALLOW_MUTATION: MutationPolicyDecision = {
  allowed: true,
};

const MUTATING_COMMANDS = new Set([
  'cp',
  'install',
  'mkdir',
  'mv',
  'perl',
  'rm',
  'sed',
  'tee',
  'touch',
  'truncate',
]);

// Known gaps, by design ("Probably" — this is a heuristic gate, not an
// adversarial security boundary): compound commands where the mutator is not
// the first token (`true && rm -rf x`), `dd of=file`, and interpreter
// one-liners (`python -c "open(..., 'w')"`) are not detected.
const PACKAGE_MUTATION_PATTERN =
  /\b(?:bun|npm|pnpm|yarn)\s+(?:add|install|i|remove|rm|uninstall|unlink|un|ci|update|up|link)\b/;
const GIT_MUTATION_PATTERN =
  /\bgit\s+(?:add|am|apply|branch\s+(?:-[dDmM]\b|--delete|--move)|checkout|cherry-pick|clean|commit|merge|mv|rebase|reset|restore|rm|stash|switch|worktree\s+(?:add|move|prune|remove|repair))\b/;
// Matches both short-option in-place forms (`-i`, `-i.bak`, `-ni`, …) and
// GNU sed's long form (`--in-place`, `--in-place=.bak`).
const IN_PLACE_EDIT_PATTERN =
  /\b(?:sed|perl)\b[^\n;&|]*\s(?:-[A-Za-z]*i(?:\s|$|['"]|[A-Za-z0-9._-])|--in-place(?:[=\s]|$))/;
const REDIRECT_WRITE_PATTERN = /(^|[^0-9])(?:>>?|&>)\s*[^&\s]/;

export function isProbablyMutatingShellCommand(command: string): boolean {
  const first = getFirstCommand(command);
  if (MUTATING_COMMANDS.has(first)) {
    if ((first === 'sed' || first === 'perl') && !IN_PLACE_EDIT_PATTERN.test(command)) {
      return false;
    }
    return true;
  }
  return (
    PACKAGE_MUTATION_PATTERN.test(command) ||
    GIT_MUTATION_PATTERN.test(command) ||
    IN_PLACE_EDIT_PATTERN.test(command) ||
    REDIRECT_WRITE_PATTERN.test(command)
  );
}

export function isInteractiveTerminalMutation(input: {
  action: string;
  command?: string;
  readonlyBannedCommands: typeof READONLY_BANNED_SPAWN_COMMANDS;
}): boolean {
  if (input.action === 'spawn') {
    const command = input.command ?? '';
    return (
      input.readonlyBannedCommands.has(getFirstCommand(command)) ||
      isProbablyMutatingShellCommand(command)
    );
  }
  return input.action === 'key' || input.action === 'type' || input.action === 'click';
}
