/**
 * Non-presentation built-in command index.
 */

import type { Command } from '../types.js';

import { agentCi } from './agent-ci/index.js';
import { agentReadiness } from './agent-readiness.js';
import { clear } from './clear.js';
import { mode } from './mode.js';
import { plan } from './plan.js';
import { rename } from './rename.js';
import { resume } from './resume.js';
import { session } from './session.js';
import { tag } from './tag.js';
import { tasks } from './tasks.js';

export const BUILTIN_COMMANDS: ReadonlyArray<Command> = [
  agentCi,
  agentReadiness,
  clear,
  mode,
  plan,
  rename,
  resume,
  session,
  tag,
  tasks,
];

export { agentCi, agentReadiness, clear, mode, plan, rename, resume, session, tag, tasks };
