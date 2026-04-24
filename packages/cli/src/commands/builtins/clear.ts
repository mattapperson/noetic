/**
 * /clear command - Clears the conversation history.
 */

import type { Command, LocalCommandCall } from '../types.js';

//#region Implementation

const call: LocalCommandCall = async (_args, ctx) => {
  ctx.clearEntries();
  return {
    type: 'skip',
  };
};

//#endregion

//#region Command Definition

export const clear: Command = {
  type: 'local',
  name: 'clear',
  description: 'Clear conversation history',
  load: async () => ({
    call,
  }),
};

//#endregion
