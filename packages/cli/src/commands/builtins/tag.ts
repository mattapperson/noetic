/**
 * /tag [name] — set or clear the current session's tag.
 * With no arg: clears the tag (if any).
 * With an arg: sets the tag. Tags are single-value per session.
 */

import type { Command, LocalCommandCall } from '../types.js';

const call: LocalCommandCall = async (args, ctx) => {
  const trimmed = args.trim().replace(/^#/, '');
  if (trimmed.length === 0) {
    const had = ctx.sessionSnapshot.tag;
    ctx.setTag(undefined);
    return {
      type: 'text',
      value: had !== undefined ? `Removed tag #${had}.` : 'No tag to remove.',
    };
  }
  ctx.setTag(trimmed);
  return {
    type: 'text',
    value: `Tagged session as #${trimmed}.`,
  };
};

export const tag: Command = {
  type: 'local',
  name: 'tag',
  description: 'Tag or untag this session',
  load: async () => ({
    call,
  }),
};
