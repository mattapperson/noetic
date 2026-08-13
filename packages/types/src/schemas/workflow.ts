/**
 * Zod schemas for JSON-serialisable workflow definitions.
 *
 * A `WorkflowDocument` is a portable, JSON-safe representation of a noetic
 * step tree. It covers every step kind. The `runCode` node carries its body as
 * a code STRING (not an in-process closure) dispatched through a subprocess
 * adapter, keeping the document JSON-safe. The hydrator in
 * `@noetic-tools/core` (`builders/workflow-hydrator.ts`) converts a validated
 * document back into live `Step` objects via the existing builders.
 */

import { z } from 'zod';
import { NoeticConfigError } from '../errors/noetic-config-error';
import type { SubHarnessKind } from '../types/sub-harness';

//#region Until Predicate Types

interface UntilAnyPredicate {
  kind: 'any';
  predicates: UntilPredicate[];
}

interface UntilAllPredicate {
  kind: 'all';
  predicates: UntilPredicate[];
}

/** @public Discriminated union of named until predicates usable in JSON workflows. */
export type UntilPredicate =
  | {
      kind: 'maxSteps';
      n: number;
    }
  | {
      kind: 'maxCost';
      usd: number;
    }
  | {
      kind: 'maxDuration';
      duration: number;
    }
  | {
      kind: 'noToolCalls';
    }
  | {
      kind: 'never';
    }
  | {
      kind: 'outputContains';
      marker: string;
    }
  | {
      kind: 'outputEquals';
      sentinel: string;
    }
  | {
      kind: 'converged';
      threshold?: number;
    }
  | UntilAnyPredicate
  | UntilAllPredicate;

//#endregion

//#region Until Predicate Schemas

const MaxStepsPredicateSchema = z.object({
  kind: z.literal('maxSteps'),
  n: z.number().int().positive(),
});

const MaxCostPredicateSchema = z.object({
  kind: z.literal('maxCost'),
  usd: z.number().positive(),
});

const MaxDurationPredicateSchema = z.object({
  kind: z.literal('maxDuration'),
  duration: z.number().positive(),
});

const NoToolCallsPredicateSchema = z.object({
  kind: z.literal('noToolCalls'),
});

const NeverPredicateSchema = z.object({
  kind: z.literal('never'),
});

const OutputContainsPredicateSchema = z.object({
  kind: z.literal('outputContains'),
  marker: z.string().min(1),
});

const OutputEqualsPredicateSchema = z.object({
  kind: z.literal('outputEquals'),
  sentinel: z.string().min(1),
});

const ConvergedPredicateSchema = z.object({
  kind: z.literal('converged'),
  threshold: z.number().min(0).max(1).optional(),
});

const UntilPredicateRef: z.ZodType<UntilPredicate> = z.lazy(() => UntilPredicateSchema);

const AnyPredicateSchema = z.object({
  kind: z.literal('any'),
  predicates: z.array(UntilPredicateRef).min(1),
});

const AllPredicateSchema = z.object({
  kind: z.literal('all'),
  predicates: z.array(UntilPredicateRef).min(1),
});

/** @public Zod schema validating a named `until` predicate (including `any`/`all` combinators). */
export const UntilPredicateSchema: z.ZodType<UntilPredicate> = z
  .union([
    MaxStepsPredicateSchema,
    MaxCostPredicateSchema,
    MaxDurationPredicateSchema,
    NoToolCallsPredicateSchema,
    NeverPredicateSchema,
    OutputContainsPredicateSchema,
    OutputEqualsPredicateSchema,
    ConvergedPredicateSchema,
    AnyPredicateSchema,
    AllPredicateSchema,
  ])
  .meta({
    id: 'UntilPredicate',
    title: 'UntilPredicate',
  });

//#endregion

//#region Merge Strategy

/** @public ESM literal enum for merge strategies. */
export const MergeStrategy = {
  Last: 'last',
  First: 'first',
  Concat: 'concat',
} as const;

/** @public Named merge strategy for inParallel nodes. */
export type MergeStrategy = (typeof MergeStrategy)[keyof typeof MergeStrategy];

/** @public Zod schema for the named merge strategy used by `inParallel` nodes. */
export const MergeStrategySchema = z.enum([
  'last',
  'first',
  'concat',
]);

//#endregion

//#region Model Params

const ModelParamsSchema = z.object({
  temperature: z.number().min(0).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  stopSequences: z.array(z.string()).optional(),
});

//#endregion

//#region Tool Entries

/**
 * A uniform tool entry on a `callModel` node. Every entry is an object keyed by
 * `type`:
 *   - A CLIENT tool is `{ type: "<registered-tool-name>" }`. The hydrator
 *     resolves `type` against the tool registry; `parameters` (if present) is
 *     ignored — client tools receive their call args from the model at runtime.
 *   - A SERVER tool is `{ type: "openrouter:web_search" | "openrouter:web_fetch",
 *     parameters?: {...} }`. The provider executes it; `parameters` keys are
 *     camelCase (e.g. `maxResults`, `searchContextSize`) — the SDK re-serialises
 *     them and silently drops unknown keys.
 *
 * Server vs client is decided by the `type` value (a reserved `openrouter:*`
 * server-tool literal vs an arbitrary tool name), not by the entry's shape.
 */
const CallModelToolEntrySchema = z.object({
  type: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

//#endregion

//#region Retry Policy

/** Retry policy for a `runCode` node, mirroring `RetryPolicy` in `@noetic-tools/types`. */
const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().positive(),
  backoff: z.enum([
    'fixed',
    'linear',
    'exponential',
  ]),
  initialDelay: z.number().nonnegative(),
  maxDelay: z.number().nonnegative().optional(),
});

//#endregion

//#region SubHarness Settings

const HarnessSettingsSchema = z.object({
  model: z.string().optional(),
  permissionMode: z
    .enum([
      'default',
      'plan',
      'acceptEdits',
      'bypassPermissions',
    ])
    .optional(),
  maxTurns: z.number().int().positive().optional(),
  allowedTools: z.array(z.string()).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const HarnessSessionPolicySchema = z.object({
  reuse: z.string().min(1).optional(),
  onComplete: z
    .enum([
      'stop',
      'detach',
      'destroy',
    ])
    .optional(),
});

//#endregion

//#region Workflow Node Types

interface WorkflowNodeBase {
  id: string;
}

/**
 * A reference to a streaming `OutputCodec` for a `callModel` node's structured
 * output. The hydrator resolves `library` from `HydrationContext.uiLibraries`
 * to a live codec (e.g. `openUi(myLibrary)` from `@noetic-tools/openui`), the
 * same registry-resolution pattern sub-harness nodes use for adapters. Kept a
 * *reference* because a codec is a runtime object, not JSON-expressible.
 */
export interface OutputCodecRef {
  /** The codec dialect. Only `'openui'` is defined today. */
  codec: 'openui';
  /** Registry key resolved from `HydrationContext.uiLibraries`. */
  library: string;
}

export interface CallModelWorkflowNode extends WorkflowNodeBase {
  kind: 'callModel';
  model?: string;
  instructions: string;
  /**
   * Tool entries. Every entry is an object `{ type, parameters? }`. A CLIENT
   * tool is `{ type: "<registered-tool-name>" }` (resolved from the registry);
   * a SERVER tool is `{ type: "openrouter:web_search" | "openrouter:web_fetch",
   * parameters?: {...} }` (executed by the provider). Client vs server is
   * decided by the `type` value.
   */
  tools?: z.infer<typeof CallModelToolEntrySchema>[];
  params?: z.infer<typeof ModelParamsSchema>;
  /** Streaming output-codec reference, resolved from `HydrationContext.uiLibraries`. */
  output?: OutputCodecRef;
}

export interface InvokeToolWorkflowNode extends WorkflowNodeBase {
  kind: 'invokeTool';
  toolName: string;
  args?: Record<string, unknown>;
}

/**
 * A node that runs a serialised code body. Unlike the programmatic
 * `step.runCode` (which carries a closure), the JSON form carries `execute` as
 * a code STRING.
 * The code is never eval'd in-process (Cloudflare Workers forbid eval); it is
 * dispatched through a subprocess adapter (`ctx.subprocess`, or a named adapter
 * resolved by ref). Execution therefore requires a subprocess adapter capable
 * of running the code and returning its stdout.
 */
export interface RunCodeWorkflowNode extends WorkflowNodeBase {
  kind: 'runCode';
  /** Source code executed in the subprocess. Receives the step input on stdin. */
  execute: string;
  /** Optional retry policy applied to the step. */
  retry?: z.infer<typeof RetryPolicySchema>;
  /** Named subprocess adapter ref; defaults to `ctx.subprocess` when omitted. */
  subprocess?: string;
}

export interface ConditionalRoute {
  /** The pattern tested against the conditional input (case-insensitive). */
  match: string;
  /**
   * How `match` is tested. `substring` (default): the trimmed, lowercased
   * input CONTAINS the lowercased pattern — beware, route 'cat' fires for
   * input 'concatenate'. `exact`: the trimmed, lowercased input EQUALS the
   * lowercased pattern. Routes are tested in order; first match wins, so
   * put more specific routes before broader ones.
   */
  matchMode?: 'substring' | 'exact';
  target: WorkflowNode;
}

export interface ConditionalWorkflowNode extends WorkflowNodeBase {
  kind: 'conditional';
  routes: ConditionalRoute[];
  default?: WorkflowNode;
}

export interface InParallelWorkflowNode extends WorkflowNodeBase {
  kind: 'inParallel';
  mode: 'race' | 'all' | 'settle';
  /**
   * Static fan-out: one child per entry. Mutually exclusive with `each` —
   * supply exactly one.
   */
  paths?: WorkflowNode[];
  /**
   * Dynamic fan-out: instantiate this body template once per item of a
   * runtime-produced array (data-dependent N). Mutually exclusive with `paths`.
   */
  each?: WorkflowNode;
  /**
   * Selector key into the inParallel input (parsed as JSON) locating the array
   * to fan out over. When omitted, the input string itself is parsed as a JSON
   * array. Only meaningful with `each`.
   */
  over?: string;
  merge?: MergeStrategy;
  concurrency?: number;
}

export interface SpawnWorkflowNode extends WorkflowNodeBase {
  kind: 'spawn';
  child: WorkflowNode;
  timeout?: number;
  /**
   * Memory layers the child runs with, by registered name (resolved from
   * `HydrationContext.layers`, like `withContext`). Omit to inherit the
   * parent's layers — the default spawn behaviour. Naming layers here REPLACES
   * the inherited set for the child, so list every layer the child needs.
   */
  layers?: string[];
}

export interface WithContextWorkflowNode extends WorkflowNodeBase {
  kind: 'withContext';
  child: WorkflowNode;
  layers: string[];
}

export interface LoopWorkflowNode extends WorkflowNodeBase {
  kind: 'loop';
  body: WorkflowNode;
  until: UntilPredicate;
  maxIterations?: number;
}

export interface SequenceWorkflowNode extends WorkflowNodeBase {
  kind: 'sequence';
  steps: WorkflowNode[];
}

export interface ScheduleWorkflowNode extends WorkflowNodeBase {
  kind: 'schedule';
  step: WorkflowNode;
  interval: number;
  onError?: 'continue' | 'fail';
}

/**
 * A node that delegates a turn to a coding-agent harness. `kind` is the harness
 * id (e.g. `claude-code`); the hydrator resolves the matching adapter from the
 * workflow's harness registry.
 */
export interface SubHarnessWorkflowNode extends WorkflowNodeBase {
  kind: SubHarnessKind;
  prompt: string;
  instructions?: string;
  settings?: z.infer<typeof HarnessSettingsSchema>;
  session?: z.infer<typeof HarnessSessionPolicySchema>;
}

/**
 * A node that runs another workflow document as a sub-step. The document is
 * either inline or a named reference resolved from `HydrationContext.workflows`
 * at execution time. Supply exactly one of `document` / `ref`.
 */
export interface SubflowWorkflowNode extends WorkflowNodeBase {
  kind: 'subflow';
  /** Inline sub-workflow. Mutually exclusive with `ref`. */
  document?: WorkflowDocument;
  /** Named sub-workflow resolved from `HydrationContext.workflows`. Mutually exclusive with `document`. */
  ref?: string;
  /** Literal input passed to the sub-workflow; defaults to the node's runtime input. */
  input?: string;
}

/** @public Discriminated union of all JSON-serialisable workflow node kinds. */
export type WorkflowNode =
  | CallModelWorkflowNode
  | InvokeToolWorkflowNode
  | RunCodeWorkflowNode
  | ConditionalWorkflowNode
  | InParallelWorkflowNode
  | SpawnWorkflowNode
  | WithContextWorkflowNode
  | LoopWorkflowNode
  | SequenceWorkflowNode
  | ScheduleWorkflowNode
  | SubflowWorkflowNode
  | SubHarnessWorkflowNode;

//#endregion

//#region Workflow Node Schema

const WorkflowNodeRef: z.ZodType<WorkflowNode> = z.lazy(() => WorkflowNodeSchema);

const SHARED_FIELDS = {
  id: z.string().min(1),
} as const;

/**
 * `execute` is capped: a runCode node's code string is embedded in the
 * document, shipped to the subprocess as an argv entry (OS argv limits are
 * of this order), and can end up in trace attributes — an unbounded string
 * is a document-size and checkpoint-size hazard with no legitimate use.
 * Named LENGTH, not BYTES, because Zod's `.max()` counts UTF-16 code units.
 */
const MAX_RUN_CODE_LENGTH = 256 * 1024;

const OutputCodecRefSchema = z.object({
  codec: z.literal('openui'),
  library: z.string().min(1),
});

const CallModelNodeSchema = z.object({
  kind: z.literal('callModel'),
  ...SHARED_FIELDS,
  model: z.string().optional(),
  instructions: z.string(),
  tools: z.array(CallModelToolEntrySchema).optional(),
  params: ModelParamsSchema.optional(),
  output: OutputCodecRefSchema.optional(),
});

const InvokeToolNodeSchema = z.object({
  kind: z.literal('invokeTool'),
  ...SHARED_FIELDS,
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});

const RunCodeNodeSchema = z.object({
  kind: z.literal('runCode'),
  ...SHARED_FIELDS,
  execute: z.string().min(1).max(MAX_RUN_CODE_LENGTH),
  retry: RetryPolicySchema.optional(),
  subprocess: z.string().min(1).optional(),
});

const ConditionalRouteSchema = z.object({
  match: z.string().min(1),
  matchMode: z
    .enum([
      'substring',
      'exact',
    ])
    .optional(),
  target: z.lazy(() => WorkflowNodeSchema),
});

const ConditionalNodeSchema = z.object({
  kind: z.literal('conditional'),
  ...SHARED_FIELDS,
  routes: z.array(ConditionalRouteSchema).min(1),
  default: WorkflowNodeRef.optional(),
});

const InParallelNodeSchema = z
  .object({
    kind: z.literal('inParallel'),
    ...SHARED_FIELDS,
    mode: z.enum([
      'race',
      'all',
      'settle',
    ]),
    paths: z.array(WorkflowNodeRef).min(1).optional(),
    each: WorkflowNodeRef.optional(),
    over: z.string().min(1).optional(),
    merge: MergeStrategySchema.optional(),
    concurrency: z.number().int().positive().optional(),
  })
  .refine((node) => (node.paths === undefined) !== (node.each === undefined), {
    message: "inParallel node requires exactly one of 'paths' (static) or 'each' (dynamic).",
  });

const SpawnNodeSchema = z.object({
  kind: z.literal('spawn'),
  ...SHARED_FIELDS,
  child: WorkflowNodeRef,
  timeout: z.number().positive().optional(),
  layers: z.array(z.string().min(1)).min(1).optional(),
});

const WithContextNodeSchema = z.object({
  kind: z.literal('withContext'),
  ...SHARED_FIELDS,
  child: WorkflowNodeRef,
  layers: z.array(z.string().min(1)).min(1),
});

const LoopNodeSchema = z.object({
  kind: z.literal('loop'),
  ...SHARED_FIELDS,
  body: WorkflowNodeRef,
  until: UntilPredicateSchema,
  maxIterations: z.number().int().positive().optional(),
});

const SequenceNodeSchema = z.object({
  kind: z.literal('sequence'),
  ...SHARED_FIELDS,
  steps: z.array(WorkflowNodeRef).min(1),
});

const ScheduleNodeSchema = z.object({
  kind: z.literal('schedule'),
  ...SHARED_FIELDS,
  step: WorkflowNodeRef,
  interval: z.number().nonnegative(),
  onError: z
    .enum([
      'continue',
      'fail',
    ])
    .optional(),
});

const WorkflowDocumentRef: z.ZodType<WorkflowDocument> = z.lazy(() => WorkflowDocumentSchema);

const SubflowNodeSchema = z
  .object({
    kind: z.literal('subflow'),
    ...SHARED_FIELDS,
    document: WorkflowDocumentRef.optional(),
    ref: z.string().min(1).optional(),
    input: z.string().optional(),
  })
  .refine((node) => (node.document === undefined) !== (node.ref === undefined), {
    message: "subflow node requires exactly one of 'document' (inline) or 'ref' (named).",
  });

/** Builds the schema for a single harness node kind (`claude-code`, `codex`, …). */
function subHarnessNodeSchema<K extends SubHarnessKind>(kind: K) {
  return z.object({
    kind: z.literal(kind),
    ...SHARED_FIELDS,
    prompt: z.string().min(1),
    instructions: z.string().optional(),
    settings: HarnessSettingsSchema.optional(),
    session: HarnessSessionPolicySchema.optional(),
  });
}

const ClaudeCodeNodeSchema = subHarnessNodeSchema('claude-code');
const CodexNodeSchema = subHarnessNodeSchema('codex');
const OpencodeNodeSchema = subHarnessNodeSchema('opencode');
const PiNodeSchema = subHarnessNodeSchema('pi');

/** @public Zod schema validating a single `WorkflowNode` (any JSON-safe kind). */
export const WorkflowNodeSchema: z.ZodType<WorkflowNode> = z
  .discriminatedUnion('kind', [
    CallModelNodeSchema,
    InvokeToolNodeSchema,
    RunCodeNodeSchema,
    ConditionalNodeSchema,
    InParallelNodeSchema,
    SpawnNodeSchema,
    WithContextNodeSchema,
    LoopNodeSchema,
    SequenceNodeSchema,
    ScheduleNodeSchema,
    SubflowNodeSchema,
    ClaudeCodeNodeSchema,
    CodexNodeSchema,
    OpencodeNodeSchema,
    PiNodeSchema,
  ])
  .meta({
    id: 'WorkflowNode',
    title: 'WorkflowNode',
  });

//#endregion

//#region Workflow Document

/** @public Top-level envelope for a JSON workflow definition. */
export interface WorkflowDocument {
  version: 1;
  root: WorkflowNode;
}

/** @public Zod schema validating a complete `WorkflowDocument`. */
export const WorkflowDocumentSchema: z.ZodType<WorkflowDocument> = z
  .object({
    version: z.literal(1),
    root: WorkflowNodeSchema,
  })
  .meta({
    id: 'WorkflowDocument',
    title: 'WorkflowDocument',
    description: 'A portable, JSON-safe representation of a Noetic step tree.',
  });

//#endregion

//#region Helpers

/** Returns the direct child nodes of a workflow node. Leaf nodes return an empty array. */
function childNodes(node: WorkflowNode): WorkflowNode[] {
  switch (node.kind) {
    case 'sequence':
      return node.steps;
    case 'inParallel':
      if (node.each) {
        return [
          node.each,
        ];
      }
      return node.paths ?? [];
    case 'spawn':
    case 'withContext':
      return [
        node.child,
      ];
    case 'loop':
      return [
        node.body,
      ];
    case 'schedule':
      return [
        node.step,
      ];
    case 'conditional': {
      const children = node.routes.map((r) => r.target);
      if (node.default) {
        children.push(node.default);
      }
      return children;
    }
    case 'subflow':
      // A named ref is a static leaf: the target document is only known at
      // hydration time, so walk/graph/depth cannot see through it.
      return node.document
        ? [
            node.document.root,
          ]
        : [];
    default:
      return [];
  }
}

/**
 * Direct children of `node` that belong to the SAME document scope. Identical
 * to `childNodes` except that an inline `subflow` document is not descended
 * into: the hydrator suffixes a subflow's node ids with `-${node.id}`, so its
 * ids live in their own namespace (see `assertUniqueNodeIds`).
 */
function sameScopeChildNodes(node: WorkflowNode): WorkflowNode[] {
  if (node.kind === 'subflow') {
    return [];
  }
  return childNodes(node);
}

/** Every inline sub-workflow document root reachable from `root`, at any depth. */
function inlineSubflowRoots(root: WorkflowNode): WorkflowNode[] {
  const roots: WorkflowNode[] = [];
  const stack: WorkflowNode[] = [
    root,
  ];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.kind === 'subflow' && node.document) {
      roots.push(node.document.root);
      continue;
    }
    stack.push(...childNodes(node));
  }
  return roots;
}

/** Enforces id uniqueness within one document scope (no subflow descent). */
function assertUniqueWithinScope(root: WorkflowNode): void {
  const seen = new Map<string, WorkflowNode['kind']>();
  const stack: WorkflowNode[] = [
    root,
  ];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    const existing = seen.get(node.id);
    if (existing !== undefined) {
      throw new NoeticConfigError({
        code: 'DUPLICATE_NODE_ID',
        message: `Workflow node id '${node.id}' is used more than once (kinds: '${existing}', '${node.kind}'). Node ids must be unique across the document.`,
        hint: 'Give every node a distinct id — resume replay, the step registry, and trace graphs all key on it.',
      });
    }
    seen.set(node.id, node.kind);
    stack.push(...sameScopeChildNodes(node));
  }
}

/**
 * Enforce node-id uniqueness per document scope. Shape validation cannot
 * express this, and downstream machinery quietly corrupts without it: the step
 * registry is latest-wins (a duplicate silently shadows its sibling),
 * `workflowGraph` emits ambiguous edges, and — worst — the step ledger keys
 * resume replay by paths built from step ids, so duplicate-id siblings line up
 * as occurrences of ONE step and can replay each other's recorded outputs. A
 * planner LLM emitting `"id": "step1"` twice is not hypothetical.
 *
 * Each document is its own scope: an inline `subflow` document's ids are
 * suffixed with `-${node.id}` at hydration, so an id shared between the outer
 * document and a nested one is unambiguous at runtime and stays legal. Every
 * inline sub-workflow is validated independently against its own subtree.
 */
function assertUniqueNodeIds(root: WorkflowNode): void {
  assertUniqueWithinScope(root);
  for (const subRoot of inlineSubflowRoots(root)) {
    assertUniqueNodeIds(subRoot);
  }
}

/**
 * Validates a candidate workflow document: Zod shape validation plus
 * per-document-scope node-id uniqueness. Throws `ZodError` on shape errors and
 * `NoeticConfigError` (`code: 'DUPLICATE_NODE_ID'`) on id collisions.
 */
export function validateWorkflow(input: unknown): WorkflowDocument {
  const doc = WorkflowDocumentSchema.parse(input);
  assertUniqueNodeIds(doc.root);
  return doc;
}

/** Walks a workflow tree depth-first, yielding each node. */
export function* walkWorkflow(node: WorkflowNode): Iterable<WorkflowNode> {
  yield node;
  for (const child of childNodes(node)) {
    yield* walkWorkflow(child);
  }
}

/** A flattened, JSON-safe view of a workflow tree: its nodes and parent→child edges. */
export interface WorkflowGraph {
  nodes: Array<{
    id: string;
    kind: WorkflowNode['kind'];
  }>;
  edges: Array<{
    from: string;
    to: string;
  }>;
}

/**
 * Flattens a workflow tree into a node + edge list — the static "potential
 * paths" of the DAG, suitable for attaching to a trace span so observers can
 * reconstruct the declared graph independent of which branches actually ran.
 * `subflow` refs are leaves: their target documents resolve at hydration time.
 */
export function workflowGraph(root: WorkflowNode): WorkflowGraph {
  const nodes: WorkflowGraph['nodes'] = [];
  const edges: WorkflowGraph['edges'] = [];
  for (const node of walkWorkflow(root)) {
    nodes.push({
      id: node.id,
      kind: node.kind,
    });
    for (const child of childNodes(node)) {
      edges.push({
        from: node.id,
        to: child.id,
      });
    }
  }
  return {
    nodes,
    edges,
  };
}

/**
 * Returns the maximum depth of a workflow tree.
 * Leaf nodes (`callModel`, `invokeTool`) have depth 0. Structural nodes add +1.
 * A `subflow` ref counts as a leaf — depth does not see through named refs.
 */
export function workflowDepth(node: WorkflowNode): number {
  const children = childNodes(node);
  if (children.length === 0) {
    return 0;
  }
  return 1 + Math.max(0, ...children.map(workflowDepth));
}

//#endregion
