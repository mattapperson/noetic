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
import { layerData, layerFunction } from '../layer-provides';
import {
  nodeKindList,
  PlanStyle,
  renderExecuting,
  renderPlanning,
  renderTerminal,
} from './plan-prompts';

export { PlanStyle } from './plan-prompts';

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
  /**
   * How the planning briefing shapes the turn. `phased` (default) marches
   * through explore → design → review → write → exit; `interview` loops
   * explore → write → ask, which suits requests whose requirements are still
   * vague.
   */
  style?: PlanStyle;
  /**
   * Name of the host's sub-agent tool, when it has one (e.g. `'agent'`). The
   * layer ships no such tool, so the briefing's parallel-exploration guidance
   * stays out until a host names one — telling the model to call a tool that is
   * not registered costs a turn and teaches it nothing.
   */
  subAgentTool?: string;
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

//#endregion

//#region Recall Renderers

interface RecallOptions {
  style: PlanStyle;
  allowedTools: string[];
  allowedNodeKinds?: WorkflowNode['kind'][];
  subAgentTool?: string;
  extra?: string;
  maxChars: number;
}

/** Returns null when the budget cannot hold anything the model could act on. */
type RecallRenderer = (state: PlanState, options: RecallOptions) => string | null;

const RECALL_RENDERERS: Partial<Record<PlanPhase, RecallRenderer>> = {
  [PlanPhase.Planning]: (state, options) =>
    renderPlanning(state, {
      style: options.style,
      schemaUrl: SCHEMA_URL,
      allowedTools: options.allowedTools,
      allowedNodeKinds: options.allowedNodeKinds,
      subAgentTool: options.subAgentTool,
      extra: options.extra,
      maxChars: options.maxChars,
    }),
  [PlanPhase.Executing]: (state, options) => renderExecuting(state, options.maxChars),
  [PlanPhase.Completed]: (state, options) => renderTerminal(state, options.maxChars),
  [PlanPhase.Failed]: (state, options) => renderTerminal(state, options.maxChars),
};

//#endregion

//#region Layer Options

/** Fully-resolved layer configuration shared by the provide executors and hooks. */
interface PlanLayerOptions {
  maxPrdLength: number;
  maxWorkflows: number;
  maxWorkflowChars: number;
  limits: DocumentLimits;
  allowedTools: Set<string>;
  style: PlanStyle;
  subAgentTool?: string;
  additionalPlanInstructions?: string;
  onEnterSession?: PlanEnterSessionCallback;
  onExit?: PlanExitCallback;
}

function resolvePlanOptions(config?: PlanContextConfig): PlanLayerOptions {
  return {
    maxPrdLength: config?.maxPrdLength ?? MAX_PRD_LENGTH,
    maxWorkflows: config?.maxWorkflows ?? MAX_WORKFLOWS,
    maxWorkflowChars: config?.maxWorkflowChars ?? MAX_WORKFLOW_CHARS,
    limits: {
      maxDepth: config?.maxDepth ?? MAX_DEPTH,
      allowedNodeKinds: config?.allowedNodeKinds,
    },
    allowedTools: buildAllowedTools(config),
    style: config?.style ?? PlanStyle.Phased,
    subAgentTool: config?.subAgentTool,
    additionalPlanInstructions: config?.additionalPlanInstructions,
    onEnterSession: config?.onEnterSession,
    onExit: config?.onExit,
  };
}

//#endregion

//#region Provide Executors

interface PlanToolResult {
  result: string;
  state: PlanState;
}

async function executeEnterPlanMode(
  args: {
    goal?: string;
  },
  state: PlanState,
  options: PlanLayerOptions,
): Promise<PlanToolResult> {
  if (state.phase === PlanPhase.Planning || state.phase === PlanPhase.Executing) {
    return {
      result: `Cannot enter plan mode: a plan is already active (phase "${state.phase}").`,
      state,
    };
  }
  const session = options.onEnterSession ? await options.onEnterSession() : null;
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
}

async function executeUpdatePrd(
  args: {
    content: string;
  },
  state: PlanState,
  options: PlanLayerOptions,
): Promise<PlanToolResult> {
  if (state.phase !== PlanPhase.Planning) {
    return {
      result: `Cannot update PRD: current phase is "${state.phase}". Enter plan mode first.`,
      state,
    };
  }
  if (args.content.length > options.maxPrdLength) {
    return {
      result: `PRD content exceeds maximum length of ${options.maxPrdLength} characters.`,
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
}

async function executeSetPlanTree(
  args: {
    document: unknown;
  },
  state: PlanState,
  options: PlanLayerOptions,
): Promise<PlanToolResult> {
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
  const limitError = checkDocumentLimits(parsed.doc, options.limits);
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
}

async function executeSetWorkflow(
  args: {
    name: string;
    document: unknown;
  },
  state: PlanState,
  options: PlanLayerOptions,
): Promise<PlanToolResult> {
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
  if (!replacing && Object.keys(state.workflows).length >= options.maxWorkflows) {
    return {
      result: `Cannot set workflow: the plan already has ${options.maxWorkflows} workflows. Remove one with plan/removeWorkflow or replace an existing name.`,
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
  if (serializedLength > options.maxWorkflowChars) {
    return {
      result: `Cannot set workflow "${args.name}": document is ${serializedLength} chars, over the ${options.maxWorkflowChars} limit. Split it into smaller named workflows.`,
      state,
    };
  }
  const limitError = checkDocumentLimits(parsed.doc, options.limits);
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
}

async function executeRemoveWorkflow(
  args: {
    name: string;
  },
  state: PlanState,
): Promise<PlanToolResult> {
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
}

async function executeGetWorkflow(
  args: {
    name: string;
  },
  state: PlanState,
): Promise<PlanToolResult> {
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
}

async function executeExitPlanMode(
  args: {
    action: 'execute' | 'cancel';
  },
  state: PlanState,
  options: PlanLayerOptions,
): Promise<PlanToolResult> {
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

  if (options.onExit) {
    const { approved } = await options.onExit(state);
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
}

//#endregion

//#region Hooks

/** Renders the phase-appropriate recall payload, or null when the layer sits the turn out. */
function renderPlanRecall(
  state: PlanState,
  budget: number,
  options: PlanLayerOptions,
): {
  items: ReturnType<typeof createMessage>[];
  tokenCount: number;
} | null {
  if (state.phase === PlanPhase.Idle) {
    return null;
  }

  const renderer = RECALL_RENDERERS[state.phase];
  if (!renderer) {
    return null;
  }

  // estimateTokens counts ~4 chars per token, so budget*4 chars is the
  // ceiling the renderer must fit under.
  const content = renderer(state, {
    style: options.style,
    allowedTools: [
      ...options.allowedTools,
    ].sort(),
    allowedNodeKinds: options.limits.allowedNodeKinds,
    subAgentTool: options.subAgentTool,
    extra: options.additionalPlanInstructions,
    maxChars: budget * 4,
  });
  // A budget too small for even the compact briefing buys nothing but a
  // fragment of a rule, so the layer sits the turn out.
  if (content === null) {
    return null;
  }
  return {
    items: [
      createMessage(content, 'developer'),
    ],
    tokenCount: estimateTokens(content),
  };
}

function buildPlanHooks(options: PlanLayerOptions): ContextLayer<PlanState>['hooks'] {
  return {
    async init({ storage }) {
      const saved = await storage.get<PlanState>('state');
      return {
        state: saved ? normalizeState(saved) : createDefaultState(),
      };
    },

    async recall({ state, budget }) {
      return renderPlanRecall(state, budget, options);
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

      if (options.allowedTools.has(toolName)) {
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
  };
}

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
export function plan(config?: PlanContextConfig): ContextLayer<PlanState> {
  const scope: ContextScope = config?.scope ?? 'thread';
  const options = resolvePlanOptions(config);

  return {
    id: 'plan',
    name: 'Plan',
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

      enterPlanMode: layerFunction<
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
        execute: (args, state) => executeEnterPlanMode(args, state, options),
      }),

      updatePrd: layerFunction<
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
        execute: (args, state) => executeUpdatePrd(args, state, options),
      }),

      setPlanTree: layerFunction<
        {
          document: unknown;
        },
        string,
        PlanState
      >({
        description:
          'Set the execution plan as a JSON workflow document: { "document": { "version": 1, "root": <WorkflowNode> } }. ' +
          // Drawn from the same table as the briefing's kind list, so the two
          // can never disagree about what this plan is allowed to use.
          `WorkflowNode is a discriminated union on "kind" (${nodeKindList(
            options.limits.allowedNodeKinds,
          )}); every node needs a unique "id". ` +
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
        execute: (args, state) => executeSetPlanTree(args, state, options),
      }),

      setWorkflow: layerFunction<
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
        execute: (args, state) => executeSetWorkflow(args, state, options),
      }),

      removeWorkflow: layerFunction<
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
        execute: (args, state) => executeRemoveWorkflow(args, state),
      }),

      getWorkflow: layerFunction<
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
        execute: (args, state) => executeGetWorkflow(args, state),
      }),

      exitPlanMode: layerFunction<
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
        execute: (args, state) => executeExitPlanMode(args, state, options),
      }),
    },
    hooks: buildPlanHooks(options),
  } satisfies ContextLayer<PlanState>;
}

//#endregion
