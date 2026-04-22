/**
 * /resume [id] — reload a previously-saved session.
 *
 * With no arg: opens the picker (runAgent's loop re-renders with the chosen session).
 * With a UUID: loads that session directly from disk and restarts the TUI.
 */

import { loadSession, loadSessionByIdAnywhere } from '../../sessions/store.js';
import type { Command, LocalCommandCall } from '../types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const call: LocalCommandCall = async (args, ctx) => {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    ctx.restartWithSession({
      kind: 'picker',
    });
    return {
      type: 'skip',
    };
  }
  if (!UUID_RE.test(trimmed)) {
    return {
      type: 'text',
      value: `"${trimmed}" is not a valid session id.`,
    };
  }
  const file = (await loadSession(ctx.cwd, trimmed)) ?? (await loadSessionByIdAnywhere(trimmed));
  if (file === null) {
    return {
      type: 'text',
      value: `Session ${trimmed} not found.`,
    };
  }
  ctx.restartWithSession({
    kind: 'file',
    file,
  });
  return {
    type: 'skip',
  };
};

export const resume: Command = {
  type: 'local',
  name: 'resume',
  description: 'Reload a prior session (opens picker, or loads by UUID)',
  load: async () => ({
    call,
  }),
};
