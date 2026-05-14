/**
 * Prebuilt subagent presets used during plan mode and (optionally) by emitted flow JSON.
 *
 * Each preset is a factory returning a composition of existing noetic step primitives
 * (`spawn` + `step.llm`). They are NOT new step kinds — the runtime sees only the
 * underlying primitives, so serialisation, tracing, memory isolation all work unchanged.
 */

import type { Step } from '@noetic-tools/core';
import { spawn, step } from '@noetic-tools/core';

import type { SubagentArgs, SubagentPreset } from '../plugins/types.js';
import { createReadOnlyTools } from '../tools/index.js';

export type { SubagentArgs, SubagentPreset } from '../plugins/types.js';

//#region Prompts

const EXPLORE_INSTRUCTIONS = [
  'You are an Explore subagent. Your single job is to investigate a focused question about the codebase using read-only tools (Read, Grep, Find, Ls).',
  '',
  'Discipline:',
  '- Do not propose designs, fixes, or implementations. Pure investigation only.',
  '- Cite file paths with `path:line_number` when you reference specific code.',
  '- Surface anything surprising or non-obvious — pre-existing patterns, hidden constraints, prior decisions reflected in code.',
  '',
  'Output format: a short, structured report (under 500 words) the orchestrator can paste directly into their planning context. No fluff.',
].join('\n');

const PLAN_INSTRUCTIONS = [
  'You are a Plan subagent. You have already received exploration findings; your job is to design an implementation approach.',
  '',
  'Discipline:',
  '- Read code yourself before recommending changes — do not trust summaries blindly.',
  '- Propose ONE recommended approach and (briefly) one rejected alternative with the reason it lost.',
  '- Identify the *Critical Files for Implementation*: list the file paths the implementer must touch, with line numbers when known.',
  '- Reuse existing functions/utilities you find rather than inventing new ones; cite their paths.',
  '',
  'Output format:',
  '- ## Recommended Approach',
  '- ## Alternative Considered',
  '- ## Critical Files for Implementation',
  '- ## Open Questions (if any)',
].join('\n');

//#endregion

//#region Helpers

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

function buildSubagent(
  prefix: string,
  baseInstructions: string,
  args: SubagentArgs,
): Step<unknown, string, string> {
  const id = args.id ?? nextId(prefix);
  const tools = createReadOnlyTools({
    cwd: args.cwd,
    fs: args.fs,
    shell: args.shell,
  });
  const instructions = [
    baseInstructions,
    '',
    '---',
    '',
    args.prompt,
  ].join('\n');

  return spawn<unknown, string, string>({
    id,
    child: step.llm<unknown, string, string>({
      id: `${id}-llm`,
      model: args.model,
      instructions,
      tools,
    }),
  });
}

//#endregion

//#region Presets

export function exploreAgent(args: SubagentArgs): Step<unknown, string, string> {
  return buildSubagent('explore', EXPLORE_INSTRUCTIONS, args);
}

export function planAgent(args: SubagentArgs): Step<unknown, string, string> {
  return buildSubagent('plan', PLAN_INSTRUCTIONS, args);
}

//#endregion

//#region Registry

export const SUBAGENT_PRESETS: Record<string, SubagentPreset> = {
  explore: exploreAgent,
  plan: planAgent,
};

export function resolveSubagentPreset(name: string): SubagentPreset | undefined {
  return SUBAGENT_PRESETS[name];
}

//#endregion
