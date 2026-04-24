/**
 * Built-in commands index.
 */

import type { Command } from '../types.js';

import { agentReadiness } from './agent-readiness.js';
import { clear } from './clear.js';
import { context } from './context.js';
import { mode } from './mode.js';
import { model } from './model.js';
import { plan } from './plan.js';
import { rename } from './rename.js';
import { resume } from './resume.js';
import { session } from './session.js';
import { skills } from './skills.js';
import { tag } from './tag.js';

/**
 * All built-in commands.
 */
export const BUILTIN_COMMANDS: ReadonlyArray<Command> = [
  agentReadiness,
  clear,
  context,
  mode,
  model,
  plan,
  rename,
  resume,
  session,
  skills,
  tag,
];

export { agentReadiness, clear, context, mode, model, plan, rename, resume, session, skills, tag };
