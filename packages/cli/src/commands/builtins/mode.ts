/**
 * /mode command — toggles the CLI agent mode (normal ↔ planning).
 *
 * Subcommands:
 *   /mode           - toggle current mode
 *   /mode plan      - enter planning mode
 *   /mode normal    - return to normal mode
 *   /mode status    - show current mode
 */

import type { Command, CommandContext, LocalCommandCall, LocalCommandResult } from '../types.js';

//#region Subcommand Handlers

type SubcommandHandler = (ctx: CommandContext) => Promise<LocalCommandResult>;

async function handleEnter(ctx: CommandContext): Promise<LocalCommandResult> {
  if (ctx.agentMode === 'planning') {
    return {
      type: 'text',
      value: 'Already in plan mode.',
    };
  }
  await ctx.setAgentMode('planning');
  return {
    type: 'text',
    value:
      'Plan mode enabled. Read-only tools only — explore the codebase, then call plan/updatePrd to write your PRD.',
  };
}

async function handleExit(ctx: CommandContext): Promise<LocalCommandResult> {
  if (ctx.agentMode === 'normal') {
    return {
      type: 'text',
      value: 'Already in normal mode.',
    };
  }
  await ctx.setAgentMode('normal');
  return {
    type: 'text',
    value: 'Returned to normal mode. Full toolset is available again.',
  };
}

async function handleStatus(ctx: CommandContext): Promise<LocalCommandResult> {
  return {
    type: 'text',
    value: `Current mode: ${ctx.agentMode}`,
  };
}

async function handleToggle(ctx: CommandContext): Promise<LocalCommandResult> {
  return ctx.agentMode === 'planning' ? handleExit(ctx) : handleEnter(ctx);
}

const SUBCOMMANDS: Record<string, SubcommandHandler> = {
  '': handleToggle,
  plan: handleEnter,
  planning: handleEnter,
  normal: handleExit,
  exit: handleExit,
  status: handleStatus,
};

//#endregion

//#region Implementation

const call: LocalCommandCall = async (args, ctx) => {
  const subcommand = args.trim().toLowerCase();
  const handler = SUBCOMMANDS[subcommand];

  if (!handler) {
    return {
      type: 'text',
      value: `Unknown mode: "${subcommand}". Available: /mode, /mode plan, /mode normal, /mode status`,
    };
  }

  return handler(ctx);
};

//#endregion

//#region Command Definition

export const mode: Command = {
  type: 'local',
  name: 'mode',
  description: 'Toggle agent mode between normal and planning',
  load: async () => ({
    call,
  }),
};

//#endregion
