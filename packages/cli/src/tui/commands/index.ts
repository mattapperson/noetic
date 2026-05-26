/**
 * TUI-aware command registry.
 */

import { agentCi } from '../../commands/builtins/agent-ci/index.js';
import { agentReadiness } from '../../commands/builtins/agent-readiness.js';
import { clear } from '../../commands/builtins/clear.js';
import { mode } from '../../commands/builtins/mode.js';
import { plan } from '../../commands/builtins/plan.js';
import { rename } from '../../commands/builtins/rename.js';
import { resume } from '../../commands/builtins/resume.js';
import { session } from '../../commands/builtins/session.js';
import { tag } from '../../commands/builtins/tag.js';
import { tasks } from '../../commands/builtins/tasks.js';
import type { Command } from '../../commands/types.js';
import { config } from './config.js';
import { context } from './context.js';
import { diffReview } from './diff-review.js';
import { model } from './model.js';
import { skills } from './skills.js';

export const BUILTIN_COMMANDS: ReadonlyArray<Command> = [
  agentCi,
  agentReadiness,
  clear,
  config,
  context,
  diffReview,
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
