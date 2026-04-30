/**
 * `/tasks` slash command. Flips the TUI from the chat view to the
 * fullscreen kanban board. The actual rendering happens in `app.tsx`
 * once `viewMode` is `'taskBoard'`.
 *
 * The command is a plain `LocalCommand` (no JSX modal); it just calls
 * `ctx.setViewMode('taskBoard')` and returns `skip` so nothing is
 * appended to the chat transcript.
 */

import type { Command, LocalCommandCall } from '../../types.js';

const call: LocalCommandCall = async (_args, ctx) => {
  if (ctx.setViewMode === undefined) {
    return {
      type: 'text',
      value: 'Task board is not available in this context.',
    };
  }
  ctx.setViewMode('taskBoard');
  return {
    type: 'skip',
  };
};

export const tasks: Command = {
  type: 'local',
  name: 'tasks',
  description: 'Open the kanban board view',
  load: async () => ({
    call,
  }),
};

export { mission } from './missions/commands/index.js';
