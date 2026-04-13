/**
 * /plan command - Manages the plan mode lifecycle.
 *
 * Subcommands:
 *   /plan          - Enter plan mode
 *   /plan status   - Show current plan status
 *   /plan cancel   - Cancel the current plan
 */

import type { Command, LocalCommandCall } from '../types.js';

//#region Subcommand Handlers

type SubcommandHandler = () => string;

function handleEnter(): string {
  return [
    'Enter plan mode. Explore the codebase with read-only tools, then produce a PRD document.',
    'Call plan/enterPlanMode to begin.',
  ].join('\n');
}

function handleStatus(): string {
  return 'Show the current plan status. Check the plan/status data for phase, PRD, and plan tree state.';
}

function handleCancel(): string {
  return 'Cancel the current plan and return to idle. Call plan/exitPlanMode with { action: "cancel" }.';
}

const SUBCOMMANDS: Record<string, SubcommandHandler> = {
  '': handleEnter,
  status: handleStatus,
  cancel: handleCancel,
};

//#endregion

//#region Implementation

const call: LocalCommandCall = async (args) => {
  const subcommand = args.trim().toLowerCase();
  const handler = SUBCOMMANDS[subcommand];

  if (!handler) {
    return {
      type: 'text',
      value: `Unknown subcommand: "${subcommand}". Available: /plan, /plan status, /plan cancel`,
    };
  }

  return {
    type: 'text',
    value: handler(),
  };
};

//#endregion

//#region Command Definition

export const plan: Command = {
  type: 'local',
  name: 'plan',
  description: 'Enter plan mode to create a PRD and execution plan',
  load: async () => ({
    call,
  }),
};

//#endregion
