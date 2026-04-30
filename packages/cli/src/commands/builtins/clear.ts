/**
 * /clear command — wipe conversation history and start a fresh session
 * (new sessionId, zero cumulative counters, no seeded history).
 */

import type { Command, LocalCommandCall } from '../types.js';

const call: LocalCommandCall = async (_args, ctx) => {
  ctx.clearSession();
  return {
    type: 'skip',
  };
};

export const clear: Command = {
  type: 'local',
  name: 'clear',
  description: 'Clear history and start a fresh session',
  load: async () => ({
    call,
  }),
};
