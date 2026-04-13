/**
 * Built-in commands index.
 */

import type { Command } from '../types.js';

import { clear } from './clear.js';
import { context } from './context.js';
import { plan } from './plan.js';
import { skills } from './skills.js';

/**
 * All built-in commands.
 */
export const BUILTIN_COMMANDS: ReadonlyArray<Command> = [
  clear,
  context,
  plan,
  skills,
];

export { clear, context, plan, skills };
