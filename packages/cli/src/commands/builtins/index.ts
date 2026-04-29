/**
 * Built-in commands index.
 */

import type { Command } from '../types.js';

import { agentCi } from './agent-ci/index.js';
import { agentReadiness } from './agent-readiness.js';
import { clear } from './clear.js';
import { config } from './config.js';
import { context } from './context.js';
import { diffReview } from './diff-review/index.js';
import { mode } from './mode.js';
import { model } from './model.js';
import { plan } from './plan.js';
import { rename } from './rename.js';
import { resume } from './resume.js';
import { session } from './session.js';
import { skills } from './skills.js';
import { tag } from './tag.js';
import { mission, tasks } from './tasks/index.js';

/**
 * All built-in commands.
 */
export const BUILTIN_COMMANDS: ReadonlyArray<Command> = [
  agentCi,
  agentReadiness,
  clear,
  config,
  context,
  diffReview,
  mission,
  mode,
  model,
  plan,
  rename,
  resume,
  session,
  skills,
  tag,
  tasks,
];

export {
  agentCi,
  agentReadiness,
  clear,
  config,
  context,
  diffReview,
  mission,
  mode,
  model,
  plan,
  rename,
  resume,
  session,
  skills,
  tag,
  tasks,
};
