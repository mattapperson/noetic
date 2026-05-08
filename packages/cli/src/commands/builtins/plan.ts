/**
 * /plan command — alias for `/mode plan` (and `/mode act` via `/plan cancel`).
 *
 * Subcommands:
 *   /plan          - enter plan mode
 *   /plan status   - show current mode
 *   /plan cancel   - exit plan mode (return to act)
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
    value: 'Plan mode enabled. Explore the codebase with read-only tools, then write your PRD.',
  };
}

async function handleStatus(ctx: CommandContext): Promise<LocalCommandResult> {
  return {
    type: 'text',
    value: `Current mode: ${ctx.agentMode}`,
  };
}

async function handleCancel(ctx: CommandContext): Promise<LocalCommandResult> {
  if (ctx.agentMode === 'act') {
    return {
      type: 'text',
      value: 'Not currently in plan mode.',
    };
  }
  await ctx.setAgentMode('act');
  return {
    type: 'text',
    value: 'Plan mode cancelled. Returned to act mode.',
  };
}

const SUBCOMMANDS: Record<string, SubcommandHandler> = {
  '': handleEnter,
  status: handleStatus,
  cancel: handleCancel,
};

//#endregion

//#region Implementation

const call: LocalCommandCall = async (args, ctx) => {
  const subcommand = args.trim().toLowerCase();
  const handler = SUBCOMMANDS[subcommand];

  if (!handler) {
    return {
      type: 'text',
      value: `Unknown subcommand: "${subcommand}". Available: /plan, /plan status, /plan cancel`,
    };
  }

  return handler(ctx);
};

//#endregion

//#region Command Definition

export const plan: Command = {
  type: 'local',
  name: 'plan',
  description: 'Enter plan mode (alias for /mode plan)',
  load: async () => ({
    call,
  }),
};

//#endregion
