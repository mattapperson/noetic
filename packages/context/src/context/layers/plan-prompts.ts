/**
 * The text the plan layer puts in front of the model: the plan-mode briefing
 * during planning, the active-plan reminder during execution, and the outcome
 * line after it ends.
 *
 * Two planning styles are offered, mirroring how a planning turn is actually
 * spent. `phased` marches through explore → design → review → write → exit and
 * suits work whose shape is already known. `interview` loops explore → write →
 * ask and suits vague requests, where the user is the missing input.
 *
 * Rendering is pure: every function takes state and returns a string, or null
 * when the budget is too small to say anything coherent. The layer owns which
 * one runs for a given phase.
 */

import type { WorkflowDocument, WorkflowNode } from '@noetic-tools/types';
import { walkWorkflow } from '@noetic-tools/types';
import type { PlanState } from './plan-context';

//#region Types

/** How the planning briefing shapes the turn. */
export const PlanStyle = {
  /** Explore → design → review → write → exit. Best when the work's shape is known. */
  Phased: 'phased',
  /** Explore → write → ask, on repeat. Best when requirements are still vague. */
  Interview: 'interview',
} as const;

export type PlanStyle = (typeof PlanStyle)[keyof typeof PlanStyle];

export interface PlanningPromptOptions {
  style: PlanStyle;
  schemaUrl: string;
  /** Every tool the layer will let through, so the briefing names what the host actually permits. */
  allowedTools: string[];
  /** Node kinds the layer will accept. Undefined means all of them. */
  allowedNodeKinds?: WorkflowNode['kind'][];
  /**
   * Name of the host's sub-agent tool, when it has one. The layer ships no such
   * tool, so the parallel-exploration guidance stays out of the briefing until a
   * host says the tool exists — instructions to call a tool that is not
   * registered cost a turn and teach the model nothing.
   */
  subAgentTool?: string;
  /** Extra host instructions appended to the briefing. */
  extra?: string;
  /** Character budget for the whole block. */
  maxChars: number;
}

/**
 * One piece of the rendered block. A `drop` block is state the model can fetch
 * back (the PRD draft, the tree JSON); everything else is a rule it cannot
 * recover once withheld, so rules are never cut mid-sentence — the whole
 * briefing gives way to a compact one instead.
 */
interface Block {
  text: string;
  drop?: boolean;
}

//#endregion

//#region Public API

/**
 * The plan-mode briefing: what the model may do, how to spend the turn, and
 * what it has so far. Returns null when even the compact briefing overflows —
 * half a rule is worse than no rule.
 */
export function renderPlanning(state: PlanState, options: PlanningPromptOptions): string | null {
  const turn =
    options.style === PlanStyle.Interview
      ? interviewTurn(options.subAgentTool)
      : phasedTurn(options.subAgentTool);

  const blocks: Block[] = [
    {
      text: [
        '<plan_mode>',
        PREAMBLE,
        '',
        tools(options.allowedTools),
        '',
        turn,
        '',
        PRD_GUIDE,
        '',
        treeGuide(options.schemaUrl, options.allowedNodeKinds),
        '',
        ACTIONS,
        '',
        ENDING_A_TURN,
      ].join('\n'),
    },
  ];

  if (options.extra) {
    blocks.push({
      text: `\n## Additional instructions\n\n${options.extra}`,
    });
  }
  if (state.prd) {
    blocks.push({
      text: `\n## Current PRD draft\n\n${state.prd}`,
      drop: true,
    });
  }
  if (state.planTree) {
    blocks.push({
      text: `\n## Current plan tree\n\n${JSON.stringify(state.planTree, null, 2)}`,
      drop: true,
    });
  }
  const summaries = workflowSummaries(state);
  if (summaries) {
    blocks.push({
      text: `\n${summaries}`,
      drop: true,
    });
  }

  return fit(blocks, {
    closingTag: '</plan_mode>',
    maxChars: options.maxChars,
    compact: COMPACT_PLANNING,
  });
}

/** The approved plan, carried into execution so the model works from it rather than from memory. */
export function renderExecuting(state: PlanState, maxChars: number): string | null {
  const blocks: Block[] = [
    {
      text: `<active_plan>\nThe plan below was approved and is now running. This is the work it describes; do not substitute a different approach for it. If what you find contradicts the plan, say so plainly in your output rather than quietly planning around it.\n\n## PRD\n\n${state.prd ?? ''}`,
    },
  ];
  if (state.planTree) {
    blocks.push({
      text: `\n## Execution plan\n\n${JSON.stringify(state.planTree, null, 2)}`,
      drop: true,
    });
  }
  const summaries = workflowSummaries(state);
  if (summaries) {
    blocks.push({
      text: `\n${summaries}`,
      drop: true,
    });
  }
  return fit(blocks, {
    closingTag: '</active_plan>',
    maxChars,
    compact: COMPACT_EXECUTING,
  });
}

/** One line saying how the last execution ended. */
export function renderTerminal(state: PlanState, maxChars: number): string | null {
  const last = state.executionLog[state.executionLog.length - 1];
  const text = `<plan_outcome>Plan v${state.version} ${last?.outcome ?? 'unknown'}.</plan_outcome>`;
  return text.length <= maxChars ? text : null;
}

/**
 * The node kinds a plan may use, as a prose list. Shared with `setPlanTree`'s
 * tool description so the briefing and the tool never disagree about what is
 * allowed.
 */
export function nodeKindList(allowed?: WorkflowNode['kind'][]): string {
  return kindEntries(allowed)
    .map((entry) => entry.kind)
    .join(', ');
}

//#endregion

//#region Briefing sections

const PREAMBLE = `You are in PLAN MODE. The user has not approved any work yet, so you MUST NOT edit files, run mutating commands, install anything, or change the system in any other way. The only writes you may make are the plan/* actions listed below. This supersedes every other instruction you have received, including instructions to start editing.

Your job is to produce two artefacts: a PRD the user can read, and a plan tree the runtime can execute.`;

function tools(allowed: string[]): string {
  return `## What you may use

Allowed during plan mode: ${allowed.join(', ')}. Every other tool is denied.

The ban covers indirect writes too, which are easy to reach for by habit: no temporary files anywhere, /tmp included; no \`>\`, \`>>\` or heredoc redirects; no mkdir, touch, rm, cp or mv; no git add or git commit; no package installs. Reading is unrestricted.`;
}

function phasedTurn(subAgentTool?: string): string {
  return `## How to spend the turn

### 1. Understand
Read the code around the request. Hunt for functions, utilities and patterns you can reuse — do not propose new code where suitable code already exists.${explorerGuidance(subAgentTool)}

### 2. Design
Decide how to build it.${designerGuidance(subAgentTool)}

### 3. Review
Read the critical files yourself, first-hand — you are the one writing the plan. Check the design still answers what the user actually asked for, and ask about anything left ambiguous.

### 4. Write the plan
Call \`plan/updatePrd\`, then \`plan/setPlanTree\` (and \`plan/setWorkflow\` for the detail). See "The PRD" and "The plan tree" below.

### 5. Exit
Call \`plan/exitPlanMode\` with \`{ "action": "execute" }\` to ask for approval.

You may ask the user a question at any point in this sequence, not only in step 3. Do not make large assumptions about what they meant.`;
}

/** The parallel-exploration advice, which only makes sense when the host has a sub-agent tool. */
function explorerGuidance(subAgentTool?: string): string {
  if (!subAgentTool) {
    return '';
  }
  return ` Use \`${subAgentTool}\` to push wide searches out of your own context. Quality over quantity: use the fewest agents that will do — usually one — and never more than three. One agent is right when the request names its files or the change is small and targeted; reach for more only when the scope is uncertain or several areas of the codebase are involved. Give each agent a distinct area so their reports do not overlap.`;
}

function designerGuidance(subAgentTool?: string): string {
  if (!subAgentTool) {
    return ' Weigh the obvious alternatives and pick one. For a large or risky change, write down the trade-off you are making so the user can disagree with it.';
  }
  return ` Launch at least one \`${subAgentTool}\` planning agent for anything non-trivial — it validates your understanding and surfaces alternatives you did not consider. Skip it only for typo fixes, single-line changes and simple renames. Up to three in parallel, each with a different perspective, when the task touches several parts of the codebase or has many edge cases: simplicity vs. performance vs. maintainability for a feature; root cause vs. workaround vs. prevention for a bug; minimal change vs. clean architecture for a refactor.

In the agent's prompt: give it the background you gathered, naming the files and the code paths you traced; state the requirements and constraints; ask for a detailed implementation plan that ends with a **Critical Files for Implementation** list of the 3–5 files most central to the work. You will read those files yourself in step 3, so the list is what makes the next step possible.`;
}

function interviewTurn(subAgentTool?: string): string {
  const parallel = subAgentTool
    ? ` Push wide searches out to \`${subAgentTool}\` when they would otherwise fill your context.`
    : '';
  return `## How to spend the turn

You are pair-planning with the user. Explore, write down what you learn, and ask when the code cannot tell you. Repeat until the plan is complete.

1. **Explore** — read code. Look for functions, utilities and patterns to reuse.${parallel}
2. **Write it down** — call \`plan/updatePrd\` after each round of discovery. Do not save it all for the end; the PRD grows from a skeleton into the finished document.
3. **Ask** — when you hit a decision the code cannot settle, call AskUserQuestion, then go back to step 1.

Start by scanning a few key files, writing a skeleton PRD (headers and rough notes), and asking your first round of questions. Do not explore exhaustively before involving the user.

**Asking well.** Never ask what you could find out by reading. Batch related questions into one call. Ask only about things the user owns: requirements, preferences, trade-offs, which edge cases matter. Scale the number of rounds to the request — a vague feature needs several, a focused bug fix may need none.

**Converging.** The plan is ready when nothing is ambiguous and it says what changes, which files change, what existing code it reuses, and how to verify it. Then set the plan tree and call \`plan/exitPlanMode\` with \`{ "action": "execute" }\`.`;
}

const PRD_GUIDE = `## The PRD

Write it with \`plan/updatePrd\` as markdown, structured with headers:

- Open with **Context**: why this change is being made — the problem it solves and the outcome intended.
- Give your recommended approach only. The alternatives you rejected are not the user's problem.
- List the paths of the files to be modified.
- Name the existing functions and utilities to reuse, with their paths.
- Close with **Verification**: how to prove the change works end to end — the command to run, the tests to run, the tools to drive.

Keep it scannable but executable. A reader should be able to skim the headers and know the shape of the work.`;

/** One line per node kind, split into the work itself and the shape it runs in. */
const KIND_ENTRIES: Array<{
  kind: WorkflowNode['kind'];
  group: 'leaf' | 'structure';
  line: string;
}> = [
  {
    kind: 'callModel',
    group: 'leaf',
    line: '`callModel` — a model turn, driven by `instructions`; give it `tools` if it needs them',
  },
  {
    kind: 'invokeTool',
    group: 'leaf',
    line: '`invokeTool` — one deterministic tool call: `toolName` plus `args`',
  },
  {
    kind: 'runCode',
    group: 'leaf',
    line: '`runCode` — code in `execute`, run by a subprocess adapter the host must provide',
  },
  {
    kind: 'claude-code',
    group: 'leaf',
    line: '`claude-code`, `codex`, `opencode`, `pi` — hand a `prompt` to a coding agent',
  },
  {
    kind: 'sequence',
    group: 'structure',
    line: '`sequence` — `steps` run in order, each fed the one before',
  },
  {
    kind: 'inParallel',
    group: 'structure',
    line: '`inParallel` — `paths` run at once (or `each` over a runtime array); `mode` is `all`, `race` or `settle`, and `merge` says how the outputs of an `all` come back together',
  },
  {
    kind: 'conditional',
    group: 'structure',
    line: '`conditional` — the FIRST route whose `match` appears in the input wins, case-insensitively, so order the routes narrowest first; `default` catches the rest',
  },
  {
    kind: 'loop',
    group: 'structure',
    line: '`loop` — run `body`, then repeat while the `until` predicate does not hold; the body always runs at least once',
  },
  {
    kind: 'schedule',
    group: 'structure',
    line: '`schedule` — run `step` on an `interval`, forever; nothing after it ever runs, so put it last',
  },
  {
    kind: 'spawn',
    group: 'structure',
    line: '`spawn` — run `child` in an isolated context, so its work does not crowd this one',
  },
  {
    kind: 'withContext',
    group: 'structure',
    line: '`withContext` — run `child` with a named set of context layers the host must have registered',
  },
  {
    kind: 'subflow',
    group: 'structure',
    line: '`subflow` — run a named workflow by `ref`',
  },
];

/** The harness kinds share one line, so they are folded into the `claude-code` entry. */
const HARNESS_KINDS: WorkflowNode['kind'][] = [
  'claude-code',
  'codex',
  'opencode',
  'pi',
];

function kindEntries(allowed?: WorkflowNode['kind'][]): typeof KIND_ENTRIES {
  if (!allowed) {
    return KIND_ENTRIES;
  }
  const permitted = new Set<string>(allowed);
  return KIND_ENTRIES.filter((entry) =>
    entry.kind === 'claude-code'
      ? HARNESS_KINDS.some((kind) => permitted.has(kind))
      : permitted.has(entry.kind),
  );
}

function treeGuide(schemaUrl: string, allowed?: WorkflowNode['kind'][]): string {
  const entries = kindEntries(allowed);
  const group = (name: 'leaf' | 'structure'): string[] =>
    entries.filter((entry) => entry.group === name).map((entry) => `- ${entry.line}`);
  const leaves = group('leaf');
  const structure = group('structure');
  const restricted = allowed
    ? '\n\nThis plan is restricted to the kinds listed above. Any other kind is rejected.'
    : '';

  return `## The plan tree

Set it with \`plan/setPlanTree\` as \`{ "document": { "version": 1, "root": <node> } }\`, conforming to ${schemaUrl}. Every node needs a unique \`id\` and a \`kind\`.${restricted}

**Leaves — the work itself**
${leaves.join('\n')}

**Structure — how the leaves are arranged**
${structure.join('\n')}

**Shaping it**
- Keep the tree the user reviews SMALL — about seven top-level nodes, readable at a glance. Push the mechanics down.
- Factor detail into named workflows: define each with \`plan/setWorkflow\` \`{ "name": "<slug>", "document": {...} }\` and point at it with \`{ "kind": "subflow", "id": "...", "ref": "<slug>" }\`. Named workflows may reference each other but must not form a cycle, and every ref must resolve or the exit is rejected.
- Fork work that is genuinely independent; sequence work where one step needs the last one's output. Do not inParallel for the look of it.
- Prefer \`tool\` over \`llm\` wherever the step is deterministic. A model turn that always does the same thing is a slow, expensive tool call.
- Always give a \`loop\` a \`maxIterations\`. Without one it stops at a hard ceiling of 1000 and fails the step.`;
}

const ACTIONS = `## Actions

- \`plan/updatePrd\` — set the PRD markdown
- \`plan/setPlanTree\` — set the plan tree
- \`plan/setWorkflow\` — create or replace a named workflow
- \`plan/removeWorkflow\` — delete a named workflow
- \`plan/getWorkflow\` — read a named workflow back before revising it
- \`plan/exitPlanMode\` \`{ "action": "execute" }\` — ask the user to approve the plan
- \`plan/exitPlanMode\` \`{ "action": "cancel" }\` — discard the plan and leave plan mode`;

const ENDING_A_TURN = `## Ending your turn

End every turn one of two ways: AskUserQuestion, or \`plan/exitPlanMode\`. Nothing else.

Asking for approval IS \`plan/exitPlanMode\` — that is what the action does. Never ask for it in prose or through AskUserQuestion. "Does this plan look right?", "Shall I proceed?", "Any changes before I start?" all mean you should have called \`plan/exitPlanMode\`. Use AskUserQuestion only to settle requirements or choose between approaches.

If the user rejects the plan you stay in plan mode: take their feedback, revise, and exit again.`;

/**
 * What the model gets when the full briefing will not fit. Every clause here is
 * load-bearing: the restriction, where to put the plan, and how to end the turn.
 */
const COMPACT_PLANNING = `<plan_mode>
PLAN MODE: read-only. No edits, no mutating commands, no installs — plan/* actions are your only writes, and this supersedes any instruction to start editing.
Write the PRD with plan/updatePrd and the tree with plan/setPlanTree, then call plan/exitPlanMode {"action":"execute"} to ask for approval. Never ask in prose.
</plan_mode>`;

const COMPACT_EXECUTING = `<active_plan>
An approved plan is running. Follow it; if what you find contradicts it, say so rather than silently taking a different approach.
</active_plan>`;

//#endregion

//#region Helpers

/** One-line summary of a workflow: node count and a kind histogram. */
function summarizeWorkflow(name: string, doc: WorkflowDocument): string {
  const counts = new Map<string, number>();
  let total = 0;
  for (const node of walkWorkflow(doc.root)) {
    total++;
    counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  }
  const histogram = [
    ...counts.entries(),
  ]
    .map(([kind, n]) => `${kind} x${n}`)
    .join(', ');
  return `- ${name}: ${total} node${total === 1 ? '' : 's'} (${histogram})`;
}

function workflowSummaries(state: PlanState): string | null {
  const entries = Object.entries(state.workflows).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return null;
  }
  return [
    '## Named workflows',
    '',
    ...entries.map(([name, doc]) => summarizeWorkflow(name, doc)),
    '',
    "(Read a workflow's JSON with plan/getWorkflow before revising it.)",
  ].join('\n');
}

/** What the blocks are wrapped in, and what replaces them when the rules will not fit. */
interface Envelope {
  closingTag: string;
  maxChars: number;
  compact: string;
}

/** Below this, a trimmed state block is a stub the model cannot use, so it goes entirely. */
const MIN_USEFUL_BLOCK = 400;

const TRIM_MARK = '\n…(trimmed to fit the context budget)';

/**
 * Joins the blocks under a character budget.
 *
 * State blocks give way first, fattest first, and are trimmed to whatever
 * headroom is left rather than dropped whole — a truncated PRD draft is worth
 * far more than the blank space dropping it leaves behind. Rules are never cut
 * mid-sentence: if they do not fit, the compact briefing replaces the lot, and
 * if even that overflows the layer says nothing at all.
 */
function fit(blocks: Block[], into: Envelope): string | null {
  const { closingTag, maxChars, compact } = into;
  const tail = `\n${closingTag}`;
  if (maxChars < tail.length) {
    return null;
  }
  const budget = maxChars - tail.length;
  const kept = [
    ...blocks,
  ];
  const total = (): number => kept.reduce((sum, block) => sum + block.text.length, 0);

  while (total() > budget) {
    const fattest = fattestDroppable(kept);
    if (fattest < 0) {
      return compact.length <= maxChars ? compact : null;
    }
    const block = kept[fattest]!;
    const headroom = budget - (total() - block.text.length);
    if (headroom >= MIN_USEFUL_BLOCK) {
      block.text = `${truncate(block.text, headroom - TRIM_MARK.length)}${TRIM_MARK}`;
      break;
    }
    kept.splice(fattest, 1);
  }

  return `${kept.map((block) => block.text).join('')}${tail}`;
}

function fattestDroppable(blocks: Block[]): number {
  let fattest = -1;
  for (const [index, block] of blocks.entries()) {
    if (block.drop && (fattest < 0 || block.text.length > blocks[fattest]!.text.length)) {
      fattest = index;
    }
  }
  return fattest;
}

/** Cuts to `max` characters without splitting a surrogate pair in half. */
function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const code = text.charCodeAt(max - 1);
  const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
  return text.slice(0, isHighSurrogate ? max - 1 : max);
}

//#endregion
