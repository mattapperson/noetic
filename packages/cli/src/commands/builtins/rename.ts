/**
 * /rename <name> — set the custom title for the current session.
 * `/rename` with no argument clears the title.
 */

import type { Command, LocalCommandCall } from '../types.js';

const call: LocalCommandCall = async (args, ctx) => {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    ctx.setCustomTitle(undefined);
    return {
      type: 'text',
      value: 'Session title cleared.',
    };
  }
  ctx.setCustomTitle(trimmed);
  return {
    type: 'text',
    value: `Session renamed to "${trimmed}".`,
  };
};

export const rename: Command = {
  type: 'local',
  name: 'rename',
  description: 'Set a custom title for this session',
  load: async () => ({
    call,
  }),
};
