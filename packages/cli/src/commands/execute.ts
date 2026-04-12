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
    // For JSX commands, we return a special result that the caller handles
    return new Promise((resolve) => {
      const onDone = (result?: string): void => {
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
        resolve({
          type: 'jsx',
          node,
        });
      });
    });
  }

  // Exhaustive check - should never reach here
  const _exhaustive: never = command;
  return _exhaustive;
}

//#endregion
