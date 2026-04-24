/**
 * Command execution.
 *
 * Dispatches command execution based on command type.
 */

import type { Command, CommandContext, CommandExecutionResult } from './types.js';

//#region Execute

export interface ExecuteCommandOptions {
  /**
   * Called when a JSX modal command invokes its `onDone` AFTER the modal has
   * opened — e.g. a deck submit that should post a summary to chat and
   * dismiss the modal. The App owns this handler so it can mutate chat +
   * modal state directly; `executeCommand` has no access to React state.
   */
  onJsxComplete?: (result: string | undefined) => void;
}

export interface ExecuteCommandArgs {
  command: Command;
  args: string;
  ctx: CommandContext;
  options?: ExecuteCommandOptions;
}

/**
 * Execute a command and return the result.
 */
export async function executeCommand(input: ExecuteCommandArgs): Promise<CommandExecutionResult> {
  const { command, args: commandArgs, ctx, options = {} } = input;

  if (command.isEnabled && !command.isEnabled()) {
    return {
      type: 'text',
      value: `Command /${command.name} is not currently available.`,
    };
  }

  if (command.type === 'local') {
    const mod = await command.load();
    const result = await mod.call(commandArgs, ctx);
    return result;
  }

  if (command.type === 'local-jsx') {
    const mod = await command.load();
    let modalOpened = false;
    const onDone = (result?: string): void => {
      // Before the modal opens, onDone isn't yet meaningful — the command
      // should return its node synchronously. After the modal opens, this
      // forwards completion to the App so chat + modal state can update.
      if (modalOpened) {
        options.onJsxComplete?.(result);
      }
    };
    const node = await mod.call(onDone, ctx, commandArgs);
    modalOpened = true;
    const displayName = command.name.charAt(0).toUpperCase() + command.name.slice(1);
    return {
      type: 'modal',
      node,
      commandName: command.name,
      dismissMessage: `${displayName} dialog dismissed`,
    };
  }

  const _exhaustive: never = command;
  return _exhaustive;
}

//#endregion
