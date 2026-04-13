/**
 * Command execution.
 *
 * Dispatches command execution based on command type.
 */

import type { Command, CommandContext, CommandExecutionResult } from './types.js';

//#region Execute

/**
 * Execute a command and return the result.
 */
export async function executeCommand(
  command: Command,
  args: string,
  ctx: CommandContext,
): Promise<CommandExecutionResult> {
  // Check if command is enabled
  if (command.isEnabled && !command.isEnabled()) {
    return {
      type: 'text',
      value: `Command /${command.name} is not currently available.`,
    };
  }

  if (command.type === 'local') {
    const mod = await command.load();
    const result = await mod.call(args, ctx);
    return result;
  }

  if (command.type === 'local-jsx') {
    const mod = await command.load();
    // For JSX commands, we need to handle two possible outcomes:
    // 1. The command returns a ReactNode to display as modal
    // 2. The command calls onDone with optional text result
    // The first one to resolve wins.
    return new Promise((resolve) => {
      let resolved = false;
      const onDone = (result?: string): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        if (result) {
          resolve({
            type: 'text',
            value: result,
          });
        } else {
          resolve({
            type: 'skip',
          });
        }
      };
      mod.call(onDone, ctx, args).then((node) => {
        if (resolved) {
          return;
        }
        resolved = true;
        // Return as modal - command name is capitalized
        const displayName = command.name.charAt(0).toUpperCase() + command.name.slice(1);
        resolve({
          type: 'modal',
          node,
          commandName: command.name,
          dismissMessage: `${displayName} dialog dismissed`,
        });
      });
    });
  }

  // Exhaustive check - should never reach here
  const _exhaustive: never = command;
  return _exhaustive;
}

//#endregion
