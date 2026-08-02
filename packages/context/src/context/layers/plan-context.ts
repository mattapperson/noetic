import type {
  ContextLayer,
  ContextScope,
  WorkflowDocument,
  WorkflowNode,
} from '@noetic-tools/types';
import {
  createMessage,
  estimateTokens,
  Slot,
  SteeringAction,
  WorkflowDocumentSchema,
  walkWorkflow,
  workflowDepth,
} from '@noetic-tools/types';
import { z } from 'zod';
import { layerData, layerFn } from '../layer-provides';

//#region Constants

const MAX_PRD_LENGTH = 5e4;
const MAX_DEPTH = 5;
const MAX_WORKFLOWS = 20;
const MAX_WORKFLOW_CHARS = 2e4;
const MAX_EXECUTION_LOG_ENTRIES = 10;
const PLAN_SLOT = Slot.PROCEDURAL - 10; // 240

const SCHEMA_URL = 'https://noetic.tools/schema/noetic-workflow.schema.json';

/** Slug rule for named workflows: lowercase alphanumeric start, then `-`/`_` allowed, max 64 chars. */
const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const ALLOWED_TOOLS_IN_PLAN_MODE = new Set([
  'Read',
  'Grep',
  'Find',
  'Ls',
  'AskUserQuestion',
  'activateSkill',
  'agent',
  'checkAgent',
  'sendMessage',
  'requestPlanApproval',
  'plan/enterPlanMode',
  'plan/updatePrd',
  'plan/setPlanTree',
  'plan/setWorkflow',
  'plan/removeWorkflow',
  'plan/getWorkflow',
  'plan/exitPlanMode',
]);

//#endregion

//#region Types

export const PlanPhase = {
  Idle: 'idle',
  Planning: 'planning',
  Executing: 'executing',
  Completed: 'completed',
  Failed: 'failed',
} as const;

export type PlanPhase = (typeof PlanPhase)[keyof typeof PlanPhase];

export interface PlanExecutionEntry {
  timestamp: number;
  version: number;
  outcome: 'success' | 'failure' | 'aborted';
}

export interface PlanState {
  phase: PlanPhase;
  prd: string | null;
  /** The reviewed plan: a complete JSON workflow document. */
  planTree: WorkflowDocument | null;
  /** Named workflows referenced from the tree via `{ kind: 'subflow', ref }` nodes. */
  workflows: Record<string, WorkflowDocument>;
  executionLog: PlanExecutionEntry[];
  version: number;
  /** Identifier of the on-disk plan session (set by `onEnterSession` host callback). */
  planSlug?: string | null;
}

/** Host-supplied callback invoked when entering plan mode. Returns a session identifier the host owns (e.g. on-disk dir slug). */
export type PlanEnterSessionCallback = () => Promise<{
  slug: string;
}>;

/**
 * Host-supplied callback invoked when the model requests `exitPlanMode` with `action: 'execute'`.
 * Return `{ approved: false }` to keep the layer in `Planning` (e.g. user rejected the plan in the UI).
 */
export type PlanExitCallback = (state: PlanState) => Promise<{
  approved: boolean;
}>;

export interface PlanContextConfig {
  scope?: ContextScope;
  additionalAllowedTools?: string[];
  maxPrdLength?: number;
  /** Max structural depth (`workflowDepth`) of the plan tree and each named workflow. Default 5. */
  maxDepth?: number;
  /** Max number of named workflows a plan may store. Default 20. */
  maxWorkflows?: number;
  /** Max serialized size (`JSON.stringify` length) of each workflow document. Default 20000. */
  maxWorkflowChars?: number;
  /**
   * Optional profile restricting which `WorkflowNode` kinds the plan tree and
   * named workflows may use. Undefined allows all kinds. Hosts that set this
   * must include `'subflow'` for named workflows to be referenceable.
   */
  allowedNodeKinds?: WorkflowNode['kind'][];
  /** Extra free-form instructions appended to the planning-phase recall payload. */
  additionalPlanInstructions?: string;
  /** Called once when the layer transitions Idle → Planning. */
  onEnterSession?: PlanEnterSessionCallback;
  /** Called when `exitPlanMode` is requested with `action: 'execute'`. */
  onExit?: PlanExitCallback;
}

interface DocumentLimits {
  maxDepth: number;
  allowedNodeKinds?: WorkflowNode['kind'][];
}

//#endregion

//#region Helpers

function createDefaultState(): PlanState {
  return {
    phase: PlanPhase.Idle,
    prd: null,
    planTree: null,
    workflows: {},
    executionLog: [],
    version: 0,
  };
}

/**
 * Persisted state may predate the WorkflowDocument plan format (legacy FlowNode
 * trees) or lack the workflows map. An unparseable tree resets to null — the
 * model simply re-authors it — rather than failing init.
 */
function normalizeState(saved: PlanState): PlanState {
  const tree =
    saved.planTree !== null && WorkflowDocumentSchema.safeParse(saved.planTree).success
      ? saved.planTree
      : null;
  const workflows: Record<string, WorkflowDocument> = {};
  for (const [name, doc] of Object.entries(saved.workflows ?? {})) {
    if (WorkflowDocumentSchema.safeParse(doc).success) {
      workflows[name] = doc;
    }
  }
  return {
    ...saved,
    planTree: tree,
    workflows,
  };
}

/**
 * LLM tool calls frequently stringify a nested-object argument. Accept the
 * document as either a native object or a JSON string, then validate against
 * `WorkflowDocumentSchema`, returning a readable error summary on failure.
 */
function parseDocument(input: unknown):
  | {
      ok: true;
      doc: WorkflowDocument;
    }
  | {
      ok: false;
      error: string;
    } {
  let candidate = input;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return {
        ok: false,
        error: 'the value is not valid JSON',
      };
    }
  }
  const parsed = WorkflowDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return {
      ok: false,
      error: issues,
    };
  }
  return {
    ok: true,
    doc: parsed.data,
  };
}

/**
 * Validates a parsed document against the layer's structural limits. Returns a
 * readable rejection string, or null when the document passes.
 */
function checkDocumentLimits(doc: WorkflowDocument, limits: DocumentLimits): string | null {
  if (workflowDepth(doc.root) > limits.maxDepth) {
    return `document exceeds maximum depth of ${limits.maxDepth}`;
  }
  if (limits.allowedNodeKinds) {
    const allowed = new Set<string>(limits.allowedNodeKinds);
    const disallowed = new Set<string>();
    for (const node of walkWorkflow(doc.root)) {
      if (!allowed.has(node.kind)) {
        disallowed.add(node.kind);
      }
    }
    if (disallowed.size > 0) {
      return `document uses disallowed node kinds: ${[
        ...disallowed,
      ].join(', ')}. Allowed: ${limits.allowedNodeKinds.join(', ')}`;
    }
  }
  const badRefs = collectSubflowRefs(doc).filter((ref) => !WORKFLOW_NAME_RE.test(ref));
  if (badRefs.length > 0) {
    return `subflow refs are not valid workflow names: ${badRefs.join(
      ', ',
    )}. Names are lowercase slugs (a-z, 0-9, -, _), max 64 chars`;
  }
  return null;
}

/** Collects every named subflow ref in a document (inline subflows contribute their nested refs via the walk). */
function collectSubflowRefs(doc: WorkflowDocument): string[] {
  const refs: string[] = [];
  for (const node of walkWorkflow(doc.root)) {
    if (node.kind === 'subflow' && node.ref) {
      refs.push(node.ref);
    }
  }
  return refs;
}

/**
 * Finds refs with no matching stored workflow, across the tree and every
 * stored workflow. Returns readable `"name" (referenced from <where>)` items.
 */
function findDanglingRefs(state: PlanState): string[] {
  const dangling: string[] = [];
  const defined = new Set(Object.keys(state.workflows));
  const check = (doc: WorkflowDocument, where: string): void => {
    for (const ref of collectSubflowRefs(doc)) {
      if (!defined.has(ref)) {
        dangling.push(`"${ref}" (referenced from ${where})`);
      }
    }
  };
  if (state.planTree) {
    check(state.planTree, 'the plan tree');
  }
  for (const [name, doc] of Object.entries(state.workflows)) {
    check(doc, `workflow "${name}"`);
  }
  return dangling;
}

/**
 * Detects a reference cycle among named workflows (self-reference included).
 * Returns the cycle path for the rejection message, or null when acyclic.
 */
function findWorkflowCycle(workflows: Record<string, WorkflowDocument>): string[] | null {
  const edges = new Map<string, string[]>();
  for (const [name, doc] of Object.entries(workflows)) {
    edges.set(
      name,
      collectSubflowRefs(doc).filter((ref) => ref in workflows),
    );
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (name: string): string[] | null => {
    if (done.has(name)) {
      return null;
    }
    if (visiting.has(name)) {
      return [
        ...path.slice(path.indexOf(name)),
        name,
      ];
    }
    visiting.add(name);
    path.push(name);
    for (const next of edges.get(name) ?? []) {
      const cycle = visit(next);
      if (cycle) {
        return cycle;
      }
    }
    path.pop();
    visiting.delete(name);
    done.add(name);
    return null;
  };
  for (const name of edges.keys()) {
    const cycle = visit(name);
    if (cycle) {
      return cycle;
    }
  }
  return null;
}

function buildAllowedTools(config?: PlanContextConfig): Set<string> {
  if (!config?.additionalAllowedTools?.length) {
    return ALLOWED_TOOLS_IN_PLAN_MODE;
  }
  return new Set([
    ...ALLOWED_TOOLS_IN_PLAN_MODE,
    ...config.additionalAllowedTools,
  ]);
}

function trimExecutionLog(log: PlanExecutionEntry[]): PlanExecutionEntry[] {
  if (log.length <= MAX_EXECUTION_LOG_ENTRIES) {
    return log;
  }
  return log.slice(log.length - MAX_EXECUTION_LOG_ENTRIES);
}

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

function renderWorkflowSummaries(state: PlanState): string[] {
  const entries = Object.entries(state.workflows).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return [];
  }
  return [
    '',
    '## Named Workflows',
    '',
    ...entries.map(([name, doc]) => summarizeWorkflow(name, doc)),
    "(Use plan/getWorkflow to review a workflow's JSON before revising it.)",
  ];
}

//#endregion

//#region Recall Renderers

function recallPlanning(state: PlanState, additionalInstructions?: string): string {
  const sections: string[] = [
    '<plan_mode>',
    'You are in PLAN MODE. You may only use read-only tools (Read, Grep, Find, Ls), AskUserQuestion, skill activation, sub-agent coordination tools, and requestPlanApproval to explore the codebase and request execution approval.',
    'Your goal is to produce a PRD document and (optionally) a structured execution plan.',
    '',
    '## Workflow (5 phases)',
    '',
    '1. **Initial Understanding** — Read code and gather context. To parallelise exploration, use the `agent` tool to spawn bounded read-only sub-agents; up to 3 in parallel. Each sub-agent returns a focused report.',
    '2. **Design** — Synthesise findings. Optionally spawn planning sub-agents (1–3 in parallel) to draft alternative implementation approaches and surface trade-offs.',
    '3. **Review** — Read the critical files identified by your subagents directly so you understand them first-hand. If anything is ambiguous, ask the user a focused question.',
    '4. **Final Plan** — Write the PRD via `plan/updatePrd`. Lead with a **Context** section (why this change), then your single recommended approach, the paths of files to modify, existing functions/utilities to reuse, and a **Verification** section. Then call `plan/setPlanTree` with `{ "document": { "version": 1, "root": <WorkflowNode> } }` — a JSON workflow conforming to ' +
      SCHEMA_URL +
      '. Node kinds: `llm` (model turn), `tool` (single tool call), `sequence`, `fork` (parallel paths), `branch` (substring routing), `loop` (body + until predicate), `spawn` (isolated child), `subflow` (reference to a named workflow), and coding-agent nodes (`claude-code`, `codex`, `opencode`, `pi`). Every node needs a unique `id`. **Keep the tree SMALL** — aim for at most ~7 top-level nodes the user can review at a glance. Factor detailed mechanics (multi-step verification, retries, fan-out) into NAMED workflows: define each with `plan/setWorkflow` `{ "name": "<slug>", "document": {...} }` and reference it from the tree with `{ "kind": "subflow", "id": "...", "ref": "<slug>" }`. Named workflows may reference other named workflows but must not form cycles.',
    '5. **Exit** — Call `plan/exitPlanMode` with `{ action: "execute" }` to request approval. Every subflow ref must name a defined workflow or the exit is rejected. The user must accept before execution begins; if they reject, you stay in Plan Mode and may revise.',
    '',
    '## Available actions',
    '- `plan/updatePrd` — set markdown PRD content',
    '- `plan/setPlanTree` — set the reviewed plan as a JSON workflow document',
    '- `plan/setWorkflow` — create or replace a named workflow (referenced via subflow nodes)',
    '- `plan/removeWorkflow` — delete a named workflow',
    "- `plan/getWorkflow` — read back a named workflow's JSON",
    '- `plan/exitPlanMode` `{ action: "execute" }` — request approval and exit to executing',
    '- `plan/exitPlanMode` `{ action: "cancel" }` — discard plan and return to idle',
    '',
    '## Constraints',
    '- DO NOT create, modify, or delete files (other than via the plan/* actions).',
    '- DO NOT run mutating shell commands. Read-only exploration only.',
    '- End each turn either by asking the user a focused clarifying question or by calling `plan/exitPlanMode`.',
  ];

  if (additionalInstructions) {
    sections.push('', '## Additional Instructions', '', additionalInstructions);
  }

  if (state.prd) {
    sections.push('', '## Current PRD Draft', '', state.prd);
  }

  if (state.planTree) {
    sections.push('', '## Current Plan Tree', '', JSON.stringify(state.planTree, null, 2));
  }

  sections.push(...renderWorkflowSummaries(state));

  sections.push('</plan_mode>');
  return sections.join('\n');
}

function recallExecuting(state: PlanState): string {
  const sections: string[] = [
    '<active_plan>',
    '## PRD',
    '',
    state.prd ?? '',
  ];
  if (state.planTree) {
    sections.push('', '## Execution Plan', '', JSON.stringify(state.planTree, null, 2));
  }
  sections.push(...renderWorkflowSummaries(state));
  sections.push('</active_plan>');
  return sections.join('\n');
}

function recallTerminal(state: PlanState): string {
  const lastEntry = state.executionLog[state.executionLog.length - 1];
  const outcome = lastEntry?.outcome ?? 'unknown';
  return `<plan_outcome>Plan v${state.version} ${outcome}.</plan_outcome>`;
}

type RecallRenderer = (state: PlanState, additionalInstructions?: string) => string;

const RECALL_RENDERERS: Partial<Record<PlanPhase, RecallRenderer>> = {
  [PlanPhase.Planning]: recallPlanning,
  [PlanPhase.Executing]: recallExecuting,
  [PlanPhase.Completed]: recallTerminal,
  [PlanPhase.Failed]: recallTerminal,
};

//#endregion

//#region Public API

/**
 * Creates a plan context layer that manages the PRD authoring and plan execution lifecycle.
 *
 * The plan tree is a JSON `WorkflowDocument`; plans additionally store named
 * workflows referenced from the tree via `subflow` nodes, keeping the reviewed
 * tree small. On approval, hosts execute the plan by feeding `planTree` and
 * `workflows` to the JSON workflow runtime (`parseAndRunWorkflow`).
 *
 * @public
 * @param config - Optional configuration for scope, allowed tools, and limits.
 * @returns A `ContextLayer` providing plan mode, PRD storage, and execution tracking.
 */
export function planContext(config?: PlanContextConfig): ContextLayer<PlanState> {
  const scope: ContextScope = config?.scope ?? 'thread';
  const maxPrdLength = config?.maxPrdLength ?? MAX_PRD_LENGTH;
  const maxWorkflows = config?.maxWorkflows ?? MAX_WORKFLOWS;
  const maxWorkflowChars = config?.maxWorkflowChars ?? MAX_WORKFLOW_CHARS;
  const limits: DocumentLimits = {
    maxDepth: config?.maxDepth ?? MAX_DEPTH,
    allowedNodeKinds: config?.allowedNodeKinds,
  };
  const allowedTools = buildAllowedTools(config);
  const additionalPlanInstructions = config?.additionalPlanInstructions;
  const onEnterSession = config?.onEnterSession;
  const onExit = config?.onExit;

  return {
    id: 'plan',
    name: 'Plan Memory',
    slot: PLAN_SLOT,
    scope,
    budget: {
      min: 100,
      max: 3e3,
    },
    provides: {
      status: layerData<
        {
          phase: PlanPhase;
          hasPrd: boolean;
          hasPlanTree: boolean;
          workflowNames: string[];
          version: number;
        },
        PlanState
      >({
        read: (state) => ({
          phase: state.phase,
          hasPrd: Boolean(state.prd),
          hasPlanTree: state.planTree !== null,
          workflowNames: Object.keys(state.workflows).sort(),
          version: state.version,
        }),
      }),

      enterPlanMode: layerFn<
        {
          goal?: string;
        },
        string,
        PlanState
      >({
        description:
          'Enter plan mode. The agent switches to read-only exploration and PRD authoring.',
        input: z.object({
          goal: z.string().optional(),
        }),
        output: z.string(),
        execute: async (args, state) => {
          if (state.phase === PlanPhase.Planning || state.phase === PlanPhase.Executing) {
            return {
              result: `Cannot enter plan mode: a plan is already active (phase "${state.phase}").`,
              state,
            };
          }
          const session = onEnterSession ? await onEnterSession() : null;
          return {
            result: 'Plan mode activated. Explore the codebase, then call plan/updatePrd.',
            state: {
              ...state,
              phase: PlanPhase.Planning,
              prd: args.goal ? `# Goal\n\n${args.goal}\n` : null,
              planTree: null,
              workflows: {},
              executionLog: [],
              version: state.version + 1,
              planSlug: session?.slug ?? null,
            },
          };
        },
      }),

      updatePrd: layerFn<
        {
          content: string;
        },
        string,
        PlanState
      >({
        description: 'Update the PRD document with new markdown content.',
        input: z.object({
          content: z.string(),
        }),
        output: z.string(),
        execute: async (args, state) => {
          if (state.phase !== PlanPhase.Planning) {
            return {
              result: `Cannot update PRD: current phase is "${state.phase}". Enter plan mode first.`,
              state,
            };
          }
          if (args.content.length > maxPrdLength) {
            return {
              result: `PRD content exceeds maximum length of ${maxPrdLength} characters.`,
              state,
            };
          }
          return {
            result: 'PRD updated successfully.',
            state: {
              ...state,
              prd: args.content,
            },
          };
        },
      }),

      setPlanTree: layerFn<
        {
          document: unknown;
        },
        string,
        PlanState
      >({
        description:
          'Set the execution plan as a JSON workflow document: { "document": { "version": 1, "root": <WorkflowNode> } }. ' +
          'WorkflowNode is a discriminated union on "kind" (llm, tool, sequence, fork, branch, loop, spawn, subflow, claude-code, codex, opencode, pi); every node needs a unique "id". ' +
          'Keep this tree SMALL — reference named workflows with { "kind": "subflow", "id": "...", "ref": "<workflow-name>" } and define them via plan/setWorkflow. ' +
          `Schema: ${SCHEMA_URL}`,
        // The document is validated with WorkflowDocumentSchema inside execute
        // rather than in the tool-parameter schema: serializing the full
        // recursive node union into tool params would balloon every planning
        // turn, and in-execute validation returns readable result strings.
        input: z.object({
          document: z.unknown(),
        }),
        output: z.string(),
        execute: async (args, state) => {
          if (state.phase !== PlanPhase.Planning) {
            return {
              result: `Cannot set plan tree: current phase is "${state.phase}". Enter plan mode first.`,
              state,
            };
          }
          const parsed = parseDocument(args.document);
          if (!parsed.ok) {
            return {
              result: `Cannot set plan tree: ${parsed.error}. See ${SCHEMA_URL}.`,
              state,
            };
          }
          const limitError = checkDocumentLimits(parsed.doc, limits);
          if (limitError) {
            return {
              result: `Cannot set plan tree: ${limitError}.`,
              state,
            };
          }
          const defined = new Set(Object.keys(state.workflows));
          const dangling = [
            ...new Set(collectSubflowRefs(parsed.doc).filter((ref) => !defined.has(ref))),
          ];
          const result =
            dangling.length > 0
              ? `Plan tree set. Subflow refs not yet defined: ${dangling.join(
                  ', ',
                )} — define each with plan/setWorkflow, then call plan/exitPlanMode.`
              : 'Plan tree set successfully. Call plan/exitPlanMode to request approval.';
          return {
            result,
            state: {
              ...state,
              planTree: parsed.doc,
            },
          };
        },
      }),

      setWorkflow: layerFn<
        {
          name: string;
          document: unknown;
        },
        string,
        PlanState
      >({
        description:
          'Create or replace a NAMED workflow that the plan tree references via { "kind": "subflow", "ref": "<name>" }. ' +
          'Name must be a slug (lowercase letters, digits, hyphens/underscores, max 64 chars). Setting an existing name replaces it. ' +
          `The document is a JSON workflow: { "version": 1, "root": <WorkflowNode> } per ${SCHEMA_URL}`,
        input: z.object({
          name: z.string().min(1),
          document: z.unknown(),
        }),
        output: z.string(),
        execute: async (args, state) => {
          if (state.phase !== PlanPhase.Planning) {
            return {
              result: `Cannot set workflow: current phase is "${state.phase}". Enter plan mode first.`,
              state,
            };
          }
          if (!WORKFLOW_NAME_RE.test(args.name)) {
            return {
              result: `Cannot set workflow: "${args.name}" is not a valid name. Use a lowercase slug (a-z, 0-9, -, _), max 64 chars, e.g. "run-tests".`,
              state,
            };
          }
          const replacing = args.name in state.workflows;
          if (!replacing && Object.keys(state.workflows).length >= maxWorkflows) {
            return {
              result: `Cannot set workflow: the plan already has ${maxWorkflows} workflows. Remove one with plan/removeWorkflow or replace an existing name.`,
              state,
            };
          }
          const parsed = parseDocument(args.document);
          if (!parsed.ok) {
            return {
              result: `Cannot set workflow "${args.name}": ${parsed.error}. See ${SCHEMA_URL}.`,
              state,
            };
          }
          const serializedLength = JSON.stringify(parsed.doc).length;
          if (serializedLength > maxWorkflowChars) {
            return {
              result: `Cannot set workflow "${args.name}": document is ${serializedLength} chars, over the ${maxWorkflowChars} limit. Split it into smaller named workflows.`,
              state,
            };
          }
          const limitError = checkDocumentLimits(parsed.doc, limits);
          if (limitError) {
            return {
              result: `Cannot set workflow "${args.name}": ${limitError}.`,
              state,
            };
          }
          const workflows = {
            ...state.workflows,
            [args.name]: parsed.doc,
          };
          const names = Object.keys(workflows).sort().join(', ');
          return {
            result: `Workflow "${args.name}" ${replacing ? 'set (replaced previous version)' : 'created'}. ${
              Object.keys(workflows).length
            } workflow(s) defined: ${names}. Call plan/exitPlanMode when the plan is complete.`,
            state: {
              ...state,
              workflows,
            },
          };
        },
      }),

      removeWorkflow: layerFn<
        {
          name: string;
        },
        string,
        PlanState
      >({
        description: 'Remove a named workflow from the plan.',
        input: z.object({
          name: z.string().min(1),
        }),
        output: z.string(),
        execute: async (args, state) => {
          if (state.phase !== PlanPhase.Planning) {
            return {
              result: `Cannot remove workflow: current phase is "${state.phase}". Enter plan mode first.`,
              state,
            };
          }
          if (!(args.name in state.workflows)) {
            const existing = Object.keys(state.workflows).sort().join(', ') || '(none)';
            return {
              result: `No workflow named "${args.name}". Existing workflows: ${existing}.`,
              state,
            };
          }
          const workflows = {
            ...state.workflows,
          };
          delete workflows[args.name];
          const remaining: PlanState = {
            ...state,
            workflows,
          };
          const stillReferenced = findDanglingRefs(remaining).filter((entry) =>
            entry.startsWith(`"${args.name}"`),
          );
          const warning =
            stillReferenced.length > 0
              ? ` Warning: it is still referenced by subflow nodes (${stillReferenced.join(
                  '; ',
                )}) — update those or re-add it before exiting.`
              : '';
          return {
            result: `Workflow "${args.name}" removed.${warning}`,
            state: remaining,
          };
        },
      }),

      getWorkflow: layerFn<
        {
          name: string;
        },
        string,
        PlanState
      >({
        description: 'Return the JSON of a named workflow so it can be reviewed or revised.',
        input: z.object({
          name: z.string().min(1),
        }),
        output: z.string(),
        execute: async (args, state) => {
          const doc = state.workflows[args.name];
          if (!doc) {
            const existing = Object.keys(state.workflows).sort().join(', ') || '(none)';
            return {
              result: `No workflow named "${args.name}". Existing workflows: ${existing}.`,
              state,
            };
          }
          return {
            result: JSON.stringify(doc, null, 2),
            state,
          };
        },
      }),

      exitPlanMode: layerFn<
        {
          action: 'execute' | 'cancel';
        },
        string,
        PlanState
      >({
        description:
          'Exit plan mode. Use action "execute" to begin executing the plan, or "cancel" to discard it.',
        input: z.object({
          action: z.enum([
            'execute',
            'cancel',
          ]),
        }),
        output: z.string(),
        execute: async (args, state) => {
          if (state.phase !== PlanPhase.Planning) {
            return {
              result: `Cannot exit plan mode: current phase is "${state.phase}".`,
              state,
            };
          }

          if (args.action === 'cancel') {
            return {
              result: 'Plan cancelled. Returned to idle.',
              state: createDefaultState(),
            };
          }

          if (!state.prd) {
            return {
              result: 'Cannot execute: no PRD has been written. Call plan/updatePrd first.',
              state,
            };
          }
          if (!state.planTree) {
            return {
              result: 'Cannot execute: no plan tree has been set. Call plan/setPlanTree first.',
              state,
            };
          }

          // Structural validation runs before onExit so the user is never
          // asked to approve a plan that cannot hydrate.
          const dangling = findDanglingRefs(state);
          if (dangling.length > 0) {
            return {
              result: `Cannot execute: subflow refs have no matching workflow: ${dangling.join(
                '; ',
              )}. Define them with plan/setWorkflow or remove the references.`,
              state,
            };
          }
          const cycle = findWorkflowCycle(state.workflows);
          if (cycle) {
            return {
              result: `Cannot execute: workflows reference each other in a cycle: ${cycle.join(
                ' -> ',
              )}. Break the cycle before exiting.`,
              state,
            };
          }

          if (onExit) {
            const { approved } = await onExit(state);
            if (!approved) {
              return {
                result:
                  'User did not approve the plan. Stay in plan mode, address their feedback, and call plan/exitPlanMode again when ready.',
                state,
              };
            }
          }

          return {
            result: 'Plan mode exited. Execution phase begun.',
            state: {
              ...state,
              phase: PlanPhase.Executing,
            },
          };
        },
      }),
    },
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<PlanState>('state');
        return {
          state: saved ? normalizeState(saved) : createDefaultState(),
        };
      },

      async recall({ state, budget }) {
        if (state.phase === PlanPhase.Idle) {
          return null;
        }

        const renderer = RECALL_RENDERERS[state.phase];
        if (!renderer) {
          return null;
        }

        const content = renderer(state, additionalPlanInstructions);
        // Respect the budget: estimateTokens uses ~4 chars/token, so cap the
        // rendered text at budget*4 chars to keep tokenCount <= budget.
        const maxChars = budget * 4;
        const trimmed = content.length > maxChars ? content.slice(0, maxChars) : content;
        return {
          items: [
            createMessage(trimmed, 'developer'),
          ],
          tokenCount: estimateTokens(trimmed),
        };
      },

      async beforeToolCall({ toolName, state }) {
        if (state.phase !== PlanPhase.Planning) {
          return {
            decision: {
              action: SteeringAction.Allow,
            },
            state,
          };
        }

        if (allowedTools.has(toolName)) {
          return {
            decision: {
              action: SteeringAction.Allow,
            },
            state,
          };
        }

        return {
          decision: {
            action: SteeringAction.Deny,
            guidance: `Plan mode is active. "${toolName}" is not allowed during planning. Use read-only tools (Read, Grep, Find, Ls) to explore the codebase, then call plan/updatePrd to write your PRD.`,
          },
          state,
        };
      },

      async onSpawn({ parentState }) {
        return {
          childState: structuredClone(parentState),
        };
      },

      async onComplete({ state, outcome }) {
        if (state.phase !== PlanPhase.Executing) {
          return;
        }

        return {
          state: {
            ...state,
            phase: outcome === 'success' ? PlanPhase.Completed : PlanPhase.Failed,
            executionLog: trimExecutionLog([
              ...state.executionLog,
              {
                timestamp: Date.now(),
                version: state.version,
                outcome,
              },
            ]),
          },
        };
      },
    },
  } satisfies ContextLayer<PlanState>;
}

//#endregion
